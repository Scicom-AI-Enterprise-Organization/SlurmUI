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
  const { nodeName, ip, sshUser, sshPort, cpus, gpus, memoryMb } = body;

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

  // SSH mode: SSH into controller and run setup commands there
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

    // Script runs ON the controller — it SSHes to the worker internally
    const nodeUser = sshUser || "root";
    const nodePort = sshPort || 22;
    const script = `#!/bin/bash
set -euo pipefail

echo "============================================"
echo "  Adding node: ${nodeName} (${ip})"
echo "============================================"
echo ""

echo "[1/6] Testing connectivity to ${ip}..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${nodePort} ${nodeUser}@${ip} 'hostname' && echo "  Connected" || { echo "  ERROR: Cannot reach ${ip}"; exit 1; }
echo ""

echo "[2/6] Installing prerequisites on ${nodeName}..."
ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} 'apt-get update -qq && apt-get install -y -qq python3 python3-pip curl 2>/dev/null || yum install -y -q python3 curl 2>/dev/null || true'
echo "  Done"
echo ""

echo "[3/6] Copying munge key to ${nodeName}..."
if [ -f /etc/munge/munge.key ]; then
  scp -o StrictHostKeyChecking=no -P ${nodePort} /etc/munge/munge.key ${nodeUser}@${ip}:/etc/munge/munge.key 2>/dev/null || \
    ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} 'mkdir -p /etc/munge' && \
    cat /etc/munge/munge.key | ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} 'cat > /etc/munge/munge.key && chmod 400 /etc/munge/munge.key && chown munge:munge /etc/munge/munge.key 2>/dev/null || true'
  echo "  Munge key copied"
else
  echo "  No munge key found on controller, skipping"
fi
echo ""

echo "[4/6] Copying slurm.conf to ${nodeName}..."
if [ -f /etc/slurm/slurm.conf ]; then
  scp -o StrictHostKeyChecking=no -P ${nodePort} /etc/slurm/slurm.conf ${nodeUser}@${ip}:/etc/slurm/slurm.conf 2>/dev/null || \
    ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} 'mkdir -p /etc/slurm' && \
    cat /etc/slurm/slurm.conf | ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} 'cat > /etc/slurm/slurm.conf'
  echo "  slurm.conf copied"
else
  echo "  No slurm.conf found on controller, skipping"
fi
echo ""

echo "[5/6] Installing and starting Slurm worker on ${nodeName}..."
ssh -o StrictHostKeyChecking=no -p ${nodePort} ${nodeUser}@${ip} bash -s <<'WORKER_SETUP'
set -euo pipefail
# Install slurm
apt-get install -y -qq slurmd munge 2>/dev/null || yum install -y -q slurm-slurmd munge 2>/dev/null || true
# Start munge
systemctl enable munge 2>/dev/null || true
systemctl start munge 2>/dev/null || true
# Start slurmd
systemctl enable slurmd 2>/dev/null || true
systemctl start slurmd 2>/dev/null || true
echo "Services started"
WORKER_SETUP
echo ""

echo "[6/6] Verifying node from controller..."
sleep 2
sinfo -N -n ${nodeName} --noheader 2>/dev/null && echo "  Node visible in sinfo" || echo "  Node not yet visible (may need slurmctld restart)"
echo ""

echo "============================================"
echo "  Node ${nodeName} added successfully!"
echo "============================================"
`;

    const enc = new TextEncoder();
    let seq = 0;

    const stream = new ReadableStream({
      start(controller) {
        const send = (data: object) => {
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {}
        };

        sshExecScript(target, script, {
          onStream: (line, s) => {
            send({ type: "stream", line, seq: seq++ });
          },
          onComplete: (success, payload) => {
            if (success) {
              send({ type: "complete", success: true, payload: {} });
              logAudit({
                action: "node.add",
                entity: "Cluster",
                entityId: id,
                metadata: { nodeName, ip, cpus, gpus, memoryMb, mode: "ssh" },
              });
            } else {
              send({ type: "complete", success: false, payload: { error: `Exit code ${payload?.exitCode}` } });
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

    await logAudit({
      action: "node.add",
      entity: "Cluster",
      entityId: id,
      metadata: { nodeName, ip, cpus, gpus, memoryMb, mode: "nats" },
    });

    return NextResponse.json({ request_id: requestId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
