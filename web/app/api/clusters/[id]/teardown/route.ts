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

echo "============================================"
echo "  Aura Cluster Teardown"
echo "============================================"
echo ""

echo "[1/5] Stopping Slurm daemons on controller..."
systemctl stop slurmctld 2>/dev/null && echo "  slurmctld stopped" || echo "  slurmctld not running"
systemctl disable slurmctld 2>/dev/null || true
systemctl stop slurmd 2>/dev/null && echo "  slurmd stopped" || echo "  slurmd not running"
systemctl disable slurmd 2>/dev/null || true
systemctl stop munge 2>/dev/null && echo "  munge stopped" || echo "  munge not running"
systemctl disable munge 2>/dev/null || true
echo ""

echo "[2/5] Removing Slurm configuration on controller..."
rm -rf /etc/slurm /etc/slurm-llnl 2>/dev/null && echo "  /etc/slurm removed" || true
rm -f /etc/munge/munge.key 2>/dev/null && echo "  munge key removed" || true
echo ""

echo "[3/5] Stopping and removing aura-agent on controller..."
systemctl stop aura-agent 2>/dev/null && echo "  aura-agent stopped" || echo "  aura-agent not running"
systemctl disable aura-agent 2>/dev/null || true
rm -f /etc/systemd/system/aura-agent.service 2>/dev/null || true
rm -rf /etc/aura-agent 2>/dev/null || true
rm -f /usr/local/bin/aura-agent 2>/dev/null || true
systemctl daemon-reload 2>/dev/null || true
echo "  aura-agent removed"
echo ""

WORKER_IPS="${workerIps}"
if [ -n "$WORKER_IPS" ]; then
  echo "[4/5] Cleaning up worker nodes..."
  for IP in $WORKER_IPS; do
    echo "  Cleaning $IP..."
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes root@$IP bash -s <<'WORKER_EOF' 2>/dev/null || echo "  WARNING: Failed to reach $IP"
      systemctl stop slurmd munge 2>/dev/null || true
      systemctl disable slurmd munge 2>/dev/null || true
      rm -rf /etc/slurm /etc/slurm-llnl 2>/dev/null || true
      rm -f /etc/munge/munge.key 2>/dev/null || true
${mgmtNfsPath ? `      umount -f ${mgmtNfsPath} 2>/dev/null || true
      sed -i '\\|${mgmtNfsPath}|d' /etc/fstab 2>/dev/null || true` : ""}
${dataNfsPath ? `      umount -f ${dataNfsPath} 2>/dev/null || true
      sed -i '\\|${dataNfsPath}|d' /etc/fstab 2>/dev/null || true` : ""}
      systemctl stop aura-agent 2>/dev/null || true
      systemctl disable aura-agent 2>/dev/null || true
      rm -f /etc/systemd/system/aura-agent.service /usr/local/bin/aura-agent 2>/dev/null || true
      rm -rf /etc/aura-agent 2>/dev/null || true
      systemctl daemon-reload 2>/dev/null || true
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
exportfs -u *:${mgmtNfsPath} 2>/dev/null || true
sed -i '\\|${mgmtNfsPath}|d' /etc/exports 2>/dev/null || true` : ""}
${dataNfsPath ? `echo "  Unexporting NFS: ${dataNfsPath}"
exportfs -u *:${dataNfsPath} 2>/dev/null || true
sed -i '\\|${dataNfsPath}|d' /etc/exports 2>/dev/null || true` : ""}
exportfs -ra 2>/dev/null || true
rm -rf /opt/aura/ansible 2>/dev/null || true
echo "  Cleanup complete"
echo ""

echo "============================================"
echo "  Teardown complete!"
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
            if (success) {
              send({ type: "complete", success: true, payload: {} });
              logAudit({
                action: "cluster.teardown",
                entity: "Cluster",
                entityId: id,
                metadata: { name: cluster.name, mode: "ssh" },
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
