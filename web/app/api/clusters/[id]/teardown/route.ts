import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { publishCommand } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

interface HostEntry {
  hostname: string;
  ip: string;
}

function buildTeardownScript(
  controllerHost: string,
  workerNodes: HostEntry[],
  mgmtNfsPath: string,
  dataNfsPath: string,
): string {
  const workerIps = workerNodes.map((n) => n.ip).join(" ");
  return `#!/bin/bash
set -euo pipefail

# All operations need root — wrap every command with sudo when we aren't.
S=""
if [ "$(id -u)" != "0" ]; then S="sudo"; fi

# Helper: run \$1 (a service name); print whether we actually stopped it
# (vs. it was already inactive). We probe state BEFORE issuing the stop so
# the report matches reality, instead of relying on stop's exit code.
stop_svc() {
  local svc="\$1"
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
}

echo "============================================"
echo "  Aura Cluster Teardown"
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
echo ""

echo "[3/5] Stopping and removing aura-agent on controller..."
stop_svc aura-agent
for path in /etc/systemd/system/aura-agent.service /etc/aura-agent /usr/local/bin/aura-agent; do
  if [ -e "\$path" ]; then
    \$S rm -rf "\$path" && echo "  removed \$path" || echo "  FAILED to remove \$path"
  fi
done
\$S systemctl daemon-reload 2>/dev/null || true
echo ""

WORKER_IPS="${workerIps}"
if [ -n "\$WORKER_IPS" ]; then
  echo "[4/5] Cleaning up worker nodes..."
  for IP in \$WORKER_IPS; do
    echo "  Cleaning \$IP..."
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes ubuntu@\$IP bash -s <<WORKER_EOF || echo "  WARNING: Failed to reach \$IP"
      RS=""
      if [ "\\\$(id -u)" != "0" ]; then RS=sudo; fi
      \\\$RS systemctl stop slurmd munge 2>&1 || true
      \\\$RS systemctl disable slurmd munge 2>&1 || true
      \\\$RS rm -rf /etc/slurm /etc/slurm-llnl /etc/munge/munge.key 2>&1 || true
${mgmtNfsPath ? `      \\\$RS umount -f ${mgmtNfsPath} 2>&1 || true
      \\\$RS sed -i '\\|${mgmtNfsPath}|d' /etc/fstab 2>&1 || true` : ""}
${dataNfsPath ? `      \\\$RS umount -f ${dataNfsPath} 2>&1 || true
      \\\$RS sed -i '\\|${dataNfsPath}|d' /etc/fstab 2>&1 || true` : ""}
      \\\$RS systemctl stop aura-agent 2>&1 || true
      \\\$RS systemctl disable aura-agent 2>&1 || true
      \\\$RS rm -f /etc/systemd/system/aura-agent.service /usr/local/bin/aura-agent 2>&1 || true
      \\\$RS rm -rf /etc/aura-agent 2>&1 || true
      \\\$RS systemctl daemon-reload 2>&1 || true
      echo "  done"
WORKER_EOF
  done
  echo ""
else
  echo "[4/5] No worker nodes to clean up"
  echo ""
fi

echo "[5/5] Final cleanup on controller..."
${mgmtNfsPath ? `echo "  Unexporting NFS: ${mgmtNfsPath}"
\$S exportfs -u "*:${mgmtNfsPath}" 2>&1 || true
\$S sed -i '\\|${mgmtNfsPath}|d' /etc/exports 2>&1 || true` : ""}
${dataNfsPath ? `echo "  Unexporting NFS: ${dataNfsPath}"
\$S exportfs -u "*:${dataNfsPath}" 2>&1 || true
\$S sed -i '\\|${dataNfsPath}|d' /etc/exports 2>&1 || true` : ""}
\$S exportfs -ra 2>&1 || true
\$S rm -rf /opt/aura/ansible 2>&1 || true
# Strip the "#### slurm hosts ####" block that hosts_block role adds
\$S sed -i '/#### start slurm hosts ####/,/#### end slurm hosts ####/d' /etc/hosts 2>&1 || true
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

for s in slurmctld slurmdbd slurmd munge aura-agent; do
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
done

for path in /etc/slurm /etc/slurm-llnl /etc/munge/munge.key /etc/aura-agent /usr/local/bin/aura-agent /etc/systemd/system/aura-agent.service /opt/aura/ansible; do
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

export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
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
