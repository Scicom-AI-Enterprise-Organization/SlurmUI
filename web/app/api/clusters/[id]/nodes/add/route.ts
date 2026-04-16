import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { publishCommand } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function appendLog(taskId: string, line: string) {
  try {
    await prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${line + "\n"} WHERE id = ${taskId}`;
  } catch {}
}

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

  // Update cluster config to include the new node
  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as Array<Record<string, unknown>>;
  hostsEntries.push({ hostname: nodeName, ip, user: sshUser || "root", port: sshPort || 22 });
  config.slurm_hosts_entries = hostsEntries;

  const nodes = (config.slurm_nodes ?? []) as Array<Record<string, unknown>>;
  nodes.push({ expression: nodeName, cpus, gpus: gpus ?? 0, memory_mb: memoryMb });
  config.slurm_nodes = nodes;

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
set -euo pipefail

S=""
if [ "$(id -u)" != "0" ]; then S="sudo"; fi

echo "============================================"
echo "  Adding node: ${nodeName} (${ip})"
echo "============================================"
echo ""

echo "[1/6] Testing connectivity to ${ip}..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${nodePort} ${nodeUser}@${ip} 'hostname' && echo "  Connected" || { echo "  ERROR: Cannot reach ${ip}"; exit 1; }
echo ""

echo "[2/6] Installing prerequisites on ${nodeName}..."
ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} 'S=""; if [ "$(id -u)" != "0" ]; then S="sudo"; fi; $S apt-get update -qq && $S apt-get install -y -qq python3 python3-pip curl 2>/dev/null || $S yum install -y -q python3 curl 2>/dev/null || true'
echo "  Done"
echo ""

echo "[3/6] Copying munge key to ${nodeName}..."
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
  if $S ls /etc/slurm/gres.conf >/dev/null 2>&1; then
    $S cat /etc/slurm/gres.conf | ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} bash -c 'S=; [ "$(id -u)" != "0" ] && S=sudo; $S tee /etc/slurm/gres.conf > /dev/null'
    echo "  gres.conf copied"
  fi
else
  echo "  No slurm.conf to copy"
fi
echo ""

echo "[6/7] Installing and starting Slurm worker on ${nodeName}..."
ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} bash -s <<'WORKER_SETUP'
S=""
if [ "$(id -u)" != "0" ]; then S="sudo"; fi
$S apt-get install -y -qq slurmd munge 2>/dev/null || $S yum install -y -q slurm-slurmd munge 2>/dev/null || true
$S systemctl enable munge 2>/dev/null || true
$S systemctl restart munge 2>/dev/null || true
$S systemctl enable slurmd 2>/dev/null || true
$S systemctl restart slurmd 2>/dev/null || true
echo "  Services started"
WORKER_SETUP
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
    sshExecScript(target, script, {
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
        } else {
          await appendLog(task.id, "\n[aura] Add node failed.");
        }
        await finishTask(task.id, success);
      },
    });

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
