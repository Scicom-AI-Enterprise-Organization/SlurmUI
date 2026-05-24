import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { publishCommand } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

interface HostEntry {
  hostname: string;
  ip: string;
  user?: string;
  port?: number;
}

function buildTeardownScript(
  controllerHost: string,
  workerNodes: HostEntry[],
  mgmtNfsPath: string,
  dataNfsPath: string,
): string {
  // Each worker entry is encoded as "user@ip:port" so the SSH loop can use
  // the configured ssh user / port. Pre-config'd clusters historically used
  // ubuntu@<ip>:22 by default, but container-based clusters often use root
  // (or expose ssh on a non-22 port). The shell below splits on '|' between
  // entries and on '@'/':' inside each entry.
  const workerIps = workerNodes
    .map((n) => `${n.user || "root"}@${n.ip}:${n.port || 22}`)
    .join("|");
  return `#!/bin/bash
set -euo pipefail

# All operations need root — wrap every command with sudo when we aren't.
S=""
if [ "$(id -u)" != "0" ]; then S="sudo"; fi

# Detect supervisor for the whole teardown — controllers vs workers may
# theoretically differ, but teardown runs on the controller first; if its
# /run/systemd/system isn't there we treat the whole flow as pm2.
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  SUPERVISOR=systemd
else
  SUPERVISOR=pm2
fi
echo "supervisor: \$SUPERVISOR"

# Helper: stop a service by name. Prints what actually happened so the
# teardown log matches reality even when nothing was running.
stop_svc() {
  local svc="\$1"
  if [ "\$SUPERVISOR" = "systemd" ]; then
    if ! systemctl list-unit-files 2>/dev/null | grep -q "^\${svc}\\."; then
      echo "  \$svc: unit not installed"
      return 0
    fi
    local state
    state=\$(systemctl is-active "\$svc" 2>/dev/null || true)
    if [ "\$state" = "active" ] || [ "\$state" = "activating" ] || [ "\$state" = "reloading" ]; then
      if \$S systemctl stop "\$svc" 2>&1; then
        echo "  \$svc: stopped"
      else
        echo "  \$svc: STOP FAILED (was \$state)"
        return 1
      fi
    else
      echo "  \$svc: not running (\$state)"
    fi
    \$S systemctl disable "\$svc" 2>/dev/null || true
  else
    # pm2 branch: pm2-go has no "describe" with exit code, so we use the
    # PID-file existence as a proxy for "is registered". \`pm2 stop\` +
    # \`pm2 delete\` *should* be enough — but pm2-go in 0.1.x has a known
    # race where the daemon respawns the underlying process moments after
    # delete (the pid file persists and autorestart kicks in once more).
    # So we also explicitly SIGTERM (then SIGKILL) the recorded PID, scrub
    # the leftover pid file, drop the /etc/aura/pm2/<svc>.json config so a
    # later pm2 resurrect can't bring it back, and re-dump the (now empty)
    # registry. That makes the verify step deterministic.
    local pidfile=/root/.pm2-go/pids/\$svc.pid
    if [ ! -f "\$pidfile" ] && [ ! -f /etc/aura/pm2/\$svc.json ]; then
      echo "  \$svc: not registered with pm2-go"
      return 0
    fi
    local pid=""
    [ -f "\$pidfile" ] && pid=\$(cat "\$pidfile" 2>/dev/null || true)
    \$S /usr/local/bin/pm2 stop "\$svc" >/dev/null 2>&1 || true
    \$S /usr/local/bin/pm2 delete "\$svc" >/dev/null 2>&1 || true
    if [ -n "\$pid" ] && kill -0 "\$pid" 2>/dev/null; then
      \$S kill -TERM "\$pid" 2>/dev/null || true
      for i in 1 2 3 4 5; do
        kill -0 "\$pid" 2>/dev/null || break
        sleep 1
      done
      kill -0 "\$pid" 2>/dev/null && \$S kill -KILL "\$pid" 2>/dev/null || true
    fi
    \$S rm -f "\$pidfile" /etc/aura/pm2/\$svc.json 2>/dev/null || true
    # Persist the now-shrunken process list so a pm2-go restart doesn't
    # resurrect this entry from the previous dump.
    setsid --wait \$S /usr/local/bin/pm2 dump >/dev/null 2>&1 || true
    echo "  \$svc: stopped"
  fi
}

echo "============================================"
echo "  SlurmUI Cluster Teardown"
echo "============================================"
echo "running as: \$(whoami) (uid=\$(id -u)) — sudo prefix: \\"\${S:-<none>}\\""
echo ""

echo "[1/5] Stopping Slurm daemons on controller..."
stop_svc slurmctld
stop_svc slurmdbd
stop_svc slurmd
stop_svc munge
echo ""

echo "[2/5] Removing Slurm configuration on controller..."
for path in /etc/slurm /etc/slurm-llnl /etc/munge/munge.key /var/spool/slurm /var/log/slurm; do
  if [ -e "\$path" ]; then
    if \$S rm -rf "\$path" 2>&1; then
      echo "  removed \$path"
    else
      echo "  FAILED to remove \$path"
    fi
  else
    echo "  \$path: already gone"
  fi
done

# Wipe per-job artifacts that bootstrap leaves behind in /tmp. Without
# this, a re-bootstrap of the same backing container (typical with
# managed-GPU hosts where the container persists across cluster create/
# destroy cycles) inherits the OLD slurmJobId numbering — slurmctld
# always restarts JobId at 1 on a fresh state dir, so the new "job 1"
# tries to write /tmp/slurm-1.out which already exists, owned by the
# previous cluster's Linux user. The mismatched ownership trips a
# "Permission denied" in slurmstepd and the job dies with WTERMSIG 53
# before any user code runs. Wipe both the per-job submit scripts
# (.aura-job-*.sh) and the default slurm-N.out output files.
echo "  wiping stale /tmp job artifacts (slurm-*.out, .aura-job-*.sh)..."
\$S rm -f /tmp/slurm-*.out /tmp/.aura-job-*.sh 2>/dev/null || true
echo ""

WORKER_IPS="${workerIps}"
if [ -n "\$WORKER_IPS" ]; then
  echo "[3/4] Cleaning up worker nodes..."
  # Worker entries are "user@ip:port" joined by '|' (see route.ts).
  # bash IFS-loop on '|' so we can parse the user/port out of each.
  OLDIFS=\$IFS
  IFS='|'
  for ENTRY in \$WORKER_IPS; do
    IFS=\$OLDIFS
    # split user@host:port
    USER_PART=\${ENTRY%%@*}
    HOSTPORT=\${ENTRY#*@}
    IP=\${HOSTPORT%%:*}
    PORT=\${HOSTPORT##*:}
    [ -z "\$PORT" ] && PORT=22
    [ -z "\$USER_PART" ] && USER_PART=root
    echo "  Cleaning \$USER_PART@\$IP:\$PORT..."
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes -p "\$PORT" "\$USER_PART@\$IP" bash -s <<WORKER_EOF || echo "  WARNING: Failed to reach \$USER_PART@\$IP:\$PORT"
      RS=""
      if [ "\\\$(id -u)" != "0" ]; then RS=sudo; fi
      # Per-worker supervisor branch — fleet may be mixed during a migration
      # so we re-detect on every node rather than trusting the controller's
      # value.
      if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
        \\\$RS systemctl stop slurmd munge 2>&1 || true
        \\\$RS systemctl disable slurmd munge 2>&1 || true
      else
        \\\$RS /usr/local/bin/pm2 delete slurmd munge 2>&1 || true
      fi
      # Also wipe /var/spool/slurm so a follow-up bootstrap with a new
      # ClusterName doesn't get "fatal: CLUSTER NAME MISMATCH" from a
      # stale clustername file in StateSaveLocation. Same reason we drop
      # /etc/slurm.
      \\\$RS rm -rf /etc/slurm /etc/slurm-llnl /etc/munge/munge.key /var/spool/slurm /var/log/slurm 2>&1 || true
${mgmtNfsPath ? `      \\\$RS umount -f ${mgmtNfsPath} 2>&1 || true
      \\\$RS sed -i '\\|${mgmtNfsPath}|d' /etc/fstab 2>&1 || true` : ""}
${dataNfsPath ? `      \\\$RS umount -f ${dataNfsPath} 2>&1 || true
      \\\$RS sed -i '\\|${dataNfsPath}|d' /etc/fstab 2>&1 || true` : ""}
      \\\$RS systemctl daemon-reload 2>/dev/null || true
      echo "  done"
WORKER_EOF
    IFS='|'
  done
  IFS=\$OLDIFS
  echo ""
else
  echo "[3/4] No worker nodes to clean up"
  echo ""
fi

echo "[4/4] Final cleanup on controller..."
${mgmtNfsPath ? `echo "  Unexporting NFS: ${mgmtNfsPath}"
\$S exportfs -u "*:${mgmtNfsPath}" 2>&1 || true
\$S sed -i '\\|${mgmtNfsPath}|d' /etc/exports 2>&1 || true` : ""}
${dataNfsPath ? `echo "  Unexporting NFS: ${dataNfsPath}"
\$S exportfs -u "*:${dataNfsPath}" 2>&1 || true
\$S sed -i '\\|${dataNfsPath}|d' /etc/exports 2>&1 || true` : ""}
\$S exportfs -ra 2>&1 || true
\$S rm -rf /opt/aura/ansible 2>&1 || true
# Strip the "#### slurm hosts ####" block the hosts_block role adds.
# In containers, /etc/hosts is typically a bind-mount — \`sed -i\` then
# fails with "cannot rename /etc/sedXXX: Device or resource busy" because
# the kernel won't let us swap the inode of a bind-mounted file. Rewrite
# in-place via cat instead: that truncates+rewrites the existing inode
# rather than creating a new one.
if [ -f /etc/hosts ] && grep -q "#### start slurm hosts ####" /etc/hosts 2>/dev/null; then
  HOSTS_TMP=\$(mktemp)
  sed '/#### start slurm hosts ####/,/#### end slurm hosts ####/d' /etc/hosts > "\$HOSTS_TMP"
  if \$S cp "\$HOSTS_TMP" /etc/hosts 2>/dev/null \\
     || \$S bash -c "cat '\$HOSTS_TMP' > /etc/hosts" 2>/dev/null; then
    echo "  stripped slurm hosts block from /etc/hosts"
  else
    echo "  WARNING: could not rewrite /etc/hosts (bind-mount?)"
  fi
  rm -f "\$HOSTS_TMP" 2>/dev/null || true
fi
echo "  Cleanup complete"
echo ""

# ─────────────────────────────────────────────────────────────────────────
# Verification — re-check every cleanup target. If anything is still
# present, exit non-zero so the API marks the teardown failed and the UI
# refuses to delete the DB record. This is the contract the UI relies on.
# ─────────────────────────────────────────────────────────────────────────
echo "[verify] Re-checking final state..."
FAILS=0
fail() { echo "  FAIL: \$1"; FAILS=\$((FAILS + 1)); }
pass() { echo "  ok:   \$1"; }

for s in slurmctld slurmdbd slurmd munge; do
  if [ "\$SUPERVISOR" = "systemd" ]; then
    if systemctl list-unit-files 2>/dev/null | grep -q "^\${s}\\."; then
      state=\$(systemctl is-active "\$s" 2>/dev/null || true)
      if [ "\$state" = "active" ] || [ "\$state" = "activating" ]; then
        fail "\$s still \$state"
      else
        pass "\$s \$state"
      fi
    else
      pass "\$s unit not present"
    fi
  else
    # pm2: still-online means the stop_svc step missed it; absent PID
    # file means properly cleaned up.
    if [ -f /root/.pm2-go/pids/\$s.pid ] && kill -0 "\$(cat /root/.pm2-go/pids/\$s.pid)" 2>/dev/null; then
      fail "\$s still online (pm2)"
    else
      pass "\$s gone from pm2"
    fi
  fi
done

for path in /etc/slurm /etc/slurm-llnl /etc/munge/munge.key /opt/aura/ansible; do
  if [ -e "\$path" ]; then
    fail "\$path still exists"
  else
    pass "\$path gone"
  fi
done

if grep -q "#### start slurm hosts ####" /etc/hosts 2>/dev/null; then
  fail "/etc/hosts still has aura slurm block"
else
  pass "/etc/hosts clean"
fi

${mgmtNfsPath ? `if grep -q "${mgmtNfsPath}" /etc/exports 2>/dev/null; then
  fail "/etc/exports still references ${mgmtNfsPath}"
else
  pass "/etc/exports clean (mgmt)"
fi` : ""}
${dataNfsPath ? `if grep -q "${dataNfsPath}" /etc/exports 2>/dev/null; then
  fail "/etc/exports still references ${dataNfsPath}"
else
  pass "/etc/exports clean (data)"
fi` : ""}

echo ""
if [ "\$FAILS" -gt 0 ]; then
  echo "============================================"
  echo "  Teardown FAILED: \$FAILS check(s) did not pass"
  echo "  DB record will NOT be deleted — fix above and retry."
  echo "============================================"
  exit 1
fi

echo "============================================"
echo "  Teardown complete — all checks passed!"
echo "============================================"
`;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  // auth: accepts session cookies (UI) and Bearer aura_* tokens (CLI).
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const clusterConfig = (cluster.config ?? {}) as Record<string, any>;
  const nodes: HostEntry[] = clusterConfig.slurm_hosts_entries ?? [];
  const workerNodes = nodes.filter((n) => n.hostname !== cluster.controllerHost);

  const sshPrivateKey = cluster.sshKey
    ? Buffer.from(cluster.sshKey.privateKey).toString("base64")
    : "";

  // SSH mode: run teardown directly via SSH and stream output
  if (cluster.connectionMode === "SSH") {
    if (!cluster.sshKey) {
      return NextResponse.json({ error: "No SSH key assigned" }, { status: 412 });
    }

    const target = {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
      proxyCommand: cluster.sshProxyCommand,
      jumpProxyCommand: cluster.sshJumpProxyCommand,
    };

    const script = buildTeardownScript(
      cluster.controllerHost,
      workerNodes,
      clusterConfig.mgmt_nfs_path ?? "",
      clusterConfig.data_nfs_path ?? "",
    );

    const requestId = randomUUID();
    const enc = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        const send = (data: object) => {
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {}
        };

        send({ type: "stream", line: `[ssh] Connecting to ${target.user}@${target.host}:${target.port}...`, seq: 0 });

        sshExecScript(target, script, {
          onStream: (line, seq) => {
            send({ type: "stream", line, seq });
          },
          onComplete: (success, payload) => {
            const exitCode = payload?.exitCode ?? null;
            if (success) {
              send({ type: "complete", success: true, payload: { exitCode } });
              logAudit({
                action: "cluster.teardown",
                entity: "Cluster",
                entityId: id,
                metadata: { name: cluster.name, mode: "ssh" },
              });
            } else {
              // Verification failed (exit 1) or SSH error. Surface the exit
              // code so the UI can show it and refuse to delete the DB row.
              send({
                type: "complete",
                success: false,
                payload: {
                  exitCode,
                  error: payload?.timedOut
                    ? "Teardown timed out"
                    : `Verification failed (exit ${exitCode ?? "?"}) — see log for failed checks`,
                },
              });
            }
            controller.close();
          },
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      },
    });
  }

  // NATS mode: send teardown command to agent
  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "teardown",
    payload: {
      nodes: workerNodes,
      ssh_private_key: sshPrivateKey,
      mgmt_nfs_path: clusterConfig.mgmt_nfs_path ?? "",
      data_nfs_path: clusterConfig.data_nfs_path ?? "",
    },
  });

  return NextResponse.json({ request_id: requestId });
}
