import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { publishCommand } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Use the serialized per-task helper so the UI sees all step lines before
// the status flips to success. Without this, fire-and-forget UPDATEs race
// with finishTask and the dialog ends up only showing [1/7] when the script
// completed in <2s.
import { appendTaskLog } from "@/lib/task-log";
const appendLog = (taskId: string, line: string) => appendTaskLog(taskId, line);

async function finishTask(taskId: string, success: boolean) {
  await prisma.backgroundTask.update({
    where: { id: taskId },
    data: { status: success ? "success" : "failed", completedAt: new Date() },
  });
}

// POST /api/clusters/[id]/nodes/add
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user || (session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  const body = await req.json();
  const { nodeName, ip, sshUser, sshPort, cpus, gpus, memoryMb, sockets, coresPerSocket, threadsPerCore } = body;
  const skts = sockets || 1;
  const cores = coresPerSocket || 1;
  const threads = threadsPerCore || 1;

  if (!nodeName || !ip || !cpus || !memoryMb) {
    return NextResponse.json(
      { error: "Missing required fields: nodeName, ip, cpus, memoryMb" },
      { status: 400 }
    );
  }

  // Update cluster config to include the new node. Upsert by hostname so
  // re-adding the same node (or recovering from a stale entry) replaces
  // instead of duplicating — duplicate NodeName= lines crash slurmctld and
  // the API then falls back to "no nodes" on the Nodes tab.
  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as Array<Record<string, unknown>>;
  const newHost = { hostname: nodeName, ip, user: sshUser || "root", port: sshPort || 22 };
  const hostIdx = hostsEntries.findIndex((h) => h.hostname === nodeName);
  if (hostIdx >= 0) hostsEntries[hostIdx] = newHost; else hostsEntries.push(newHost);
  config.slurm_hosts_entries = hostsEntries;

  const nodes = (config.slurm_nodes ?? []) as Array<Record<string, unknown>>;
  const newNode = { expression: nodeName, cpus, gpus: gpus ?? 0, memory_mb: memoryMb };
  const nodeIdx = nodes.findIndex((n) => n.expression === nodeName || n.name === nodeName);
  if (nodeIdx >= 0) nodes[nodeIdx] = newNode; else nodes.push(newNode);
  config.slurm_nodes = nodes;

  // New nodes default to the first partition (or seed a "main" partition if
  // none exist). Admins can reassign via the Partitions tab.
  const partitions = (config.slurm_partitions ?? []) as Array<Record<string, unknown>>;
  if (partitions.length === 0) {
    partitions.push({ name: "main", default: true, nodes: nodeName, max_time: "INFINITE", state: "UP" });
  } else {
    const first = partitions[0] as any;
    const cur = typeof first.nodes === "string" ? first.nodes : "";
    if (cur !== "ALL" && !cur.split(",").map((n: string) => n.trim()).includes(nodeName)) {
      first.nodes = cur ? `${cur},${nodeName}` : nodeName;
    }
  }
  config.slurm_partitions = partitions;

  await prisma.cluster.update({
    where: { id },
    data: { config: config as any },
  });

  // SSH mode: run in background
  if (cluster.connectionMode === "SSH") {
    if (!cluster.sshKey) {
      return NextResponse.json({ error: "No SSH key assigned" }, { status: 412 });
    }

    const task = await prisma.backgroundTask.create({
      data: { clusterId: id, type: "add_node" },
    });

    const target = {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
    };

    const nodeUser = sshUser || "root";
    const nodePort = sshPort || 22;
    const script = `#!/bin/bash
# Relaxed error handling on purpose — every step has its own "|| true" / "||"
# guard and an echo that reports the outcome, so \`set -e\` only makes things
# worse by silently killing the script on the first || that it mis-parses
# as a failure.
set +e
# Surface EVERY stderr line via the outer ssh stream so we can see why bash
# bails if it does. Also trap EXIT to log the last line number on exit —
# critical when the script silently stops mid-run.
exec 2>&1
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

S=""
if [ "$(id -u)" != "0" ]; then S="sudo"; fi

echo "============================================"
echo "  Adding node: ${nodeName} (${ip})"
echo "============================================"
echo ""

echo "[1/7] Testing connectivity to ${ip}..."
if ssh -n -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${nodePort} ${nodeUser}@${ip} 'hostname' 2>&1; then
  echo "  Connected"
else
  echo "  ERROR: Cannot reach ${ip} — aborting"
  exit 1
fi
echo ""

echo "[2/7] Installing prerequisites on ${nodeName}..."
ssh -n -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} 'S=""; if [ "$(id -u)" != "0" ]; then S="sudo"; fi; $S apt-get update -qq && $S apt-get install -y -qq python3 python3-pip curl 2>/dev/null || $S yum install -y -q python3 curl 2>/dev/null || true'
echo "  Done"
echo ""

echo "[3/7] Copying munge key to ${nodeName}..."
if $S ls /etc/munge/munge.key >/dev/null 2>&1; then
  $S cat /etc/munge/munge.key | ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} bash -c 'S=; [ "$(id -u)" != "0" ] && S=sudo; $S mkdir -p /etc/munge; $S tee /etc/munge/munge.key > /dev/null; $S chmod 400 /etc/munge/munge.key; $S chown munge:munge /etc/munge/munge.key 2>/dev/null || true'
  echo "  Munge key copied"
else
  echo "  No munge key found on controller — run Bootstrap first"
fi
echo ""

echo "[4/7] Adding/updating node in slurm.conf on controller..."
if $S ls /etc/slurm/slurm.conf >/dev/null 2>&1; then
  # Ensure file ends with a newline before appending
  $S bash -c 'tail -c1 /etc/slurm/slurm.conf | read -r _ || echo "" >> /etc/slurm/slurm.conf'

  # Ensure GresTypes=gpu is set if the node has GPUs
  if [ "${gpus}" -gt 0 ] 2>/dev/null && ! $S grep -q "^GresTypes=" /etc/slurm/slurm.conf; then
    $S sed -i '/^SelectType=/a GresTypes=gpu' /etc/slurm/slurm.conf
    echo "  Added GresTypes=gpu"
  fi

  # Create gres.conf with explicit GPU device paths if node has GPUs
  ${(gpus ?? 0) > 0 ? `$S bash -c 'cat > /etc/slurm/gres.conf' << 'GRES_EOF'
${Array.from({ length: gpus }, (_, i) => `Name=gpu File=/dev/nvidia${i}`).join("\n")}
GRES_EOF
  echo "  Created /etc/slurm/gres.conf with ${gpus} GPU device entries"` : `$S rm -f /etc/slurm/gres.conf 2>/dev/null || true
  echo "  No GPUs — no gres.conf needed"`}

  # Build the NodeName line with full topology
  NODE_LINE="NodeName=${nodeName} NodeAddr=${ip} CPUs=${cpus} Sockets=${skts} CoresPerSocket=${cores} ThreadsPerCore=${threads} RealMemory=${memoryMb} ${(gpus ?? 0) > 0 ? `Gres=gpu:${gpus} ` : ""}State=UNKNOWN"

  # Remove any existing entry for this node, then add the new one
  $S sed -i "/^NodeName=${nodeName} /d" /etc/slurm/slurm.conf
  echo "$NODE_LINE" | $S tee -a /etc/slurm/slurm.conf > /dev/null
  echo "  Updated NodeName=${nodeName}"

  # Add default partition if none exists
  if ! $S grep -q "^PartitionName=" /etc/slurm/slurm.conf 2>/dev/null; then
    echo "PartitionName=main Default=YES Nodes=${nodeName} MaxTime=INFINITE State=UP" | $S tee -a /etc/slurm/slurm.conf > /dev/null
    echo "  Added default partition 'main'"
  else
    # Add this node to existing partition if not already in Nodes= list
    PART_LINE=$($S grep "^PartitionName=" /etc/slurm/slurm.conf | head -1)
    PART_NAME=$(echo "$PART_LINE" | sed 's/PartitionName=\\([^ ]*\\).*/\\1/')
    if ! echo "$PART_LINE" | grep -q "${nodeName}"; then
      CURRENT_NODES=$(echo "$PART_LINE" | grep -oP 'Nodes=\\K[^ ]*')
      NEW_NODES="$CURRENT_NODES,${nodeName}"
      $S sed -i "s|Nodes=$CURRENT_NODES|Nodes=$NEW_NODES|" /etc/slurm/slurm.conf
      echo "  Added ${nodeName} to partition $PART_NAME"
    else
      echo "  ${nodeName} already in partition $PART_NAME"
    fi
  fi
  echo "  Restarting slurmctld..."
  $S systemctl restart slurmctld 2>/dev/null || true
  sleep 2
  # Clear any drain/invalid state on this node
  $S scontrol update NodeName=${nodeName} State=IDLE Reason="aura add_node" 2>/dev/null || \
  $S scontrol update NodeName=${nodeName} State=DOWN Reason="aura add_node" 2>/dev/null && \
  $S scontrol update NodeName=${nodeName} State=RESUME 2>/dev/null || true
  echo "  Node state cleared"
else
  echo "  No slurm.conf found on controller — run Bootstrap first"
fi
echo ""

echo "[5/7] Copying slurm.conf and gres.conf to ${nodeName}..."
if $S ls /etc/slurm/slurm.conf >/dev/null 2>&1; then
  $S cat /etc/slurm/slurm.conf | ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} bash -c 'S=; [ "$(id -u)" != "0" ] && S=sudo; $S mkdir -p /etc/slurm; $S tee /etc/slurm/slurm.conf > /dev/null'
  echo "  slurm.conf copied"
  # cgroup.conf is required whenever slurm.conf references TaskPlugin=task/cgroup
  # or ProctrackType=proctrack/cgroup (which our default slurm.conf does). Without
  # this file on the worker, slurmstepd can't launch tasks and srun dies with the
  # misleading "Header lengths are longer than data received".
  if $S ls /etc/slurm/cgroup.conf >/dev/null 2>&1; then
    $S cat /etc/slurm/cgroup.conf | ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} bash -c 'S=; [ "$(id -u)" != "0" ] && S=sudo; $S tee /etc/slurm/cgroup.conf > /dev/null'
    echo "  cgroup.conf copied"
  fi
  if $S ls /etc/slurm/gres.conf >/dev/null 2>&1; then
    $S cat /etc/slurm/gres.conf | ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} bash -c 'S=; [ "$(id -u)" != "0" ] && S=sudo; $S tee /etc/slurm/gres.conf > /dev/null'
    echo "  gres.conf copied"
  fi
else
  echo "  No slurm.conf to copy"
fi
echo ""

echo "[6/7] Installing and starting Slurm worker on ${nodeName}..."
# Discover the controller's slurm/munge UIDs so we can pre-create users with
# matching UIDs on the worker. If we skip this, the apt package creates
# slurm/munge with default UIDs (64030 / whatever) that differ from the
# controller's, and every RPC fails with "Security violation, Unexpected uid".
SLURM_UID=$($S id -u slurm 2>/dev/null || echo "")
SLURM_GID=$($S id -g slurm 2>/dev/null || echo "")
MUNGE_UID=$($S id -u munge 2>/dev/null || echo "")
MUNGE_GID=$($S id -g munge 2>/dev/null || echo "")
echo "  controller uids: slurm=$SLURM_UID:$SLURM_GID munge=$MUNGE_UID:$MUNGE_GID"
ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} \
  env CTRL_SLURM_UID="$SLURM_UID" CTRL_SLURM_GID="$SLURM_GID" CTRL_MUNGE_UID="$MUNGE_UID" CTRL_MUNGE_GID="$MUNGE_GID" \
  bash -s <<'WORKER_SETUP'
S=""
if [ "$(id -u)" != "0" ]; then S="sudo"; fi

# Create slurm + munge groups/users BEFORE apt-install so dpkg's postinst
# finds them already present and doesn't allocate a random UID. This is
# the single most common source of "Security violation, Unexpected uid"
# errors in multi-node clusters.
if [ -n "$CTRL_SLURM_GID" ]; then
  $S getent group slurm >/dev/null || $S groupadd --system --gid "$CTRL_SLURM_GID" slurm 2>&1 | head -3 || true
fi
if [ -n "$CTRL_SLURM_UID" ]; then
  $S getent passwd slurm >/dev/null || $S useradd --system --uid "$CTRL_SLURM_UID" --gid slurm \
    --home /var/lib/slurm --shell /usr/sbin/nologin slurm 2>&1 | head -3 || true
fi
if [ -n "$CTRL_MUNGE_GID" ]; then
  $S getent group munge >/dev/null || $S groupadd --system --gid "$CTRL_MUNGE_GID" munge 2>&1 | head -3 || true
fi
if [ -n "$CTRL_MUNGE_UID" ]; then
  $S getent passwd munge >/dev/null || $S useradd --system --uid "$CTRL_MUNGE_UID" --gid munge \
    --home /var/lib/munge --shell /usr/sbin/nologin munge 2>&1 | head -3 || true
fi
echo "  worker uids before install: slurm=$(id -u slurm 2>/dev/null || echo missing) munge=$(id -u munge 2>/dev/null || echo missing)"

# Strip the 127.0.1.1 <hostname> line that Ubuntu cloud-init writes into
# /etc/hosts — it makes hostname resolve to loopback, which breaks multi-node
# rendezvous (Gloo/NCCL master_addr ends up as 127.0.1.1 and remote ranks
# get Connection refused).
$S sed -i "/^127\\.0\\.1\\.1[[:space:]]/d" /etc/hosts || true

$S apt-get install -y -qq slurmd slurm-client munge 2>/dev/null || $S yum install -y -q slurm-slurmd slurm munge 2>/dev/null || true

# Post-install UID check — apt might have "repaired" our pre-created user
# or picked its own UID if ours clashed with something. If the UIDs still
# differ from the controller after install, Slurm RPCs will fail with
# "Security violation, Unexpected uid".
WORKER_SLURM_UID=$(id -u slurm 2>/dev/null || echo missing)
WORKER_MUNGE_UID=$(id -u munge 2>/dev/null || echo missing)
echo "  worker uids after install:  slurm=$WORKER_SLURM_UID munge=$WORKER_MUNGE_UID"
if [ "$WORKER_SLURM_UID" = "$CTRL_SLURM_UID" ] && [ "$WORKER_MUNGE_UID" = "$CTRL_MUNGE_UID" ]; then
  echo "  UID match: OK (slurm=$CTRL_SLURM_UID, munge=$CTRL_MUNGE_UID)"
else
  echo "  UID MISMATCH: controller slurm=$CTRL_SLURM_UID worker=$WORKER_SLURM_UID / controller munge=$CTRL_MUNGE_UID worker=$WORKER_MUNGE_UID"
  echo "  — forcing usermod to align (fixes 'Security violation, Unexpected uid')"
  if [ "$WORKER_SLURM_UID" != "$CTRL_SLURM_UID" ] && [ -n "$CTRL_SLURM_UID" ]; then
    $S systemctl stop slurmd 2>/dev/null || true
    $S usermod -u "$CTRL_SLURM_UID" slurm 2>&1 | head -3 || true
    $S groupmod -g "$CTRL_SLURM_GID" slurm 2>&1 | head -3 || true
    $S find /var/spool/slurm /var/log/slurm /var/run/slurm /var/lib/slurm -xdev 2>/dev/null \
      | xargs -r $S chown "$CTRL_SLURM_UID:$CTRL_SLURM_GID" 2>/dev/null || true
  fi
  if [ "$WORKER_MUNGE_UID" != "$CTRL_MUNGE_UID" ] && [ -n "$CTRL_MUNGE_UID" ]; then
    $S systemctl stop munge 2>/dev/null || true
    $S usermod -u "$CTRL_MUNGE_UID" munge 2>&1 | head -3 || true
    $S groupmod -g "$CTRL_MUNGE_GID" munge 2>&1 | head -3 || true
    $S find /etc/munge /var/lib/munge /var/log/munge /var/run/munge -xdev 2>/dev/null \
      | xargs -r $S chown "$CTRL_MUNGE_UID:$CTRL_MUNGE_GID" 2>/dev/null || true
  fi
  echo "  worker uids final:          slurm=$(id -u slurm 2>/dev/null || echo missing) munge=$(id -u munge 2>/dev/null || echo missing)"
fi

# slurmd refuses to start if its spool / log / run dirs don't exist. The
# package doesn't create them on Ubuntu — must do it ourselves, owned by
# the slurm user (uid 64030 on Debian/Ubuntu; fall back to root when the
# slurm user doesn't exist on the worker yet).
SLURM_OWN="slurm:slurm"
id slurm >/dev/null 2>&1 || SLURM_OWN="root:root"
$S mkdir -p /var/spool/slurm/slurmd /var/spool/slurm/slurmctld /var/log/slurm /var/run/slurm
$S chown -R "$SLURM_OWN" /var/spool/slurm /var/log/slurm /var/run/slurm

# Don't start slurmd/munge yet — the munge package just wrote a fresh random
# key, which will mismatch the controller's. The outer script re-copies the
# key in step 6b below, then starts the daemons.
WORKER_SETUP

# Step 6b: re-copy munge key AFTER apt install (package's postinst may have
# overwritten it) and only then restart munge+slurmd on the worker, so both
# daemons come up with a key that matches the controller's.
if $S ls /etc/munge/munge.key >/dev/null 2>&1; then
  $S cat /etc/munge/munge.key | ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} bash -c 'S=; [ "$(id -u)" != "0" ] && S=sudo; $S tee /etc/munge/munge.key > /dev/null; $S chmod 400 /etc/munge/munge.key; $S chown munge:munge /etc/munge/munge.key 2>/dev/null || true; $S systemctl enable munge slurmd 2>/dev/null || true; $S systemctl restart munge 2>&1 | head -3; sleep 1; $S systemctl restart slurmd 2>&1 | head -5; $S systemctl is-active slurmd >/dev/null 2>&1 && echo "  slurmd: active" || echo "  slurmd: FAILED — see journalctl -u slurmd"'
  echo "  munge key re-synced post-install"
fi
echo ""

echo "[7/7] Verifying node from controller..."
sleep 3
sinfo -N -n ${nodeName} --noheader 2>/dev/null && echo "  Node visible in sinfo" || echo "  Node not yet visible (may take a moment)"
sinfo -N --noheader 2>/dev/null || true
echo ""

echo "============================================"
echo "  Node ${nodeName} added successfully!"
echo "============================================"
`;

    // Run in background — don't await
    const handle = sshExecScript(target, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          await appendLog(task.id, "\n[aura] Node added successfully.");
          logAudit({ action: "node.add", entity: "Cluster", entityId: id, metadata: { nodeName, ip, mode: "ssh" } });
          // Flip deployed:true in cluster config so the UI hides the Deploy
          // button on this row. Fetch fresh to avoid clobbering concurrent
          // edits made while the install ran.
          try {
            const fresh = await prisma.cluster.findUnique({ where: { id } });
            if (fresh) {
              const cfg = (fresh.config ?? {}) as Record<string, unknown>;
              const list = (cfg.slurm_nodes ?? []) as Array<Record<string, unknown>>;
              const i = list.findIndex((n) => n.expression === nodeName || n.name === nodeName);
              if (i >= 0) {
                list[i] = { ...list[i], deployed: true };
                cfg.slurm_nodes = list;
                await prisma.cluster.update({ where: { id }, data: { config: cfg as any } });
              }
            }
          } catch {}
        } else {
          await appendLog(task.id, "\n[aura] Add node failed or was cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);

    return NextResponse.json({ taskId: task.id });
  }

  // NATS mode: send command to agent
  const activeClusterUsers = await prisma.clusterUser.findMany({
    where: { clusterId: id, status: "ACTIVE" },
    include: { user: { select: { unixUsername: true, unixUid: true, unixGid: true } } },
  });
  const existingUsers = activeClusterUsers
    .filter((cu) => cu.user.unixUsername && cu.user.unixUid != null && cu.user.unixGid != null)
    .map((cu) => ({
      username: cu.user.unixUsername!,
      uid: cu.user.unixUid!,
      gid: cu.user.unixGid!,
    }));

  const extraPackages: string[] = (config.installed_packages as string[]) ?? [];
  const requestId = randomUUID();

  try {
    await publishCommand(id, {
      request_id: requestId,
      type: "add_node",
      payload: {
        target_node: nodeName,
        target_ip: ip,
        config,
        existing_users: existingUsers,
        extra_packages: extraPackages,
      },
    });

    await logAudit({ action: "node.add", entity: "Cluster", entityId: id, metadata: { nodeName, ip, mode: "nats" } });
    return NextResponse.json({ request_id: requestId });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 503 });
  }
}
