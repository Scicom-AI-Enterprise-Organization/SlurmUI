import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";

interface RouteParams { params: Promise<{ id: string }> }

interface Partition {
  name: string;
  default?: boolean;
  nodes: string;
  max_time?: string;
  state?: string;
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

// POST — rewrite PartitionName=... lines in slurm.conf on controller + restart slurmctld
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
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key assigned" }, { status: 412 });

  const config = cluster.config as Record<string, unknown>;
  const partitions = (config.slurm_partitions ?? []) as Partition[];
  if (partitions.length === 0) {
    return NextResponse.json({ error: "No partitions defined" }, { status: 400 });
  }

  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: "apply_partitions" },
  });

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const partitionLines = partitions.map((p) => {
    const parts = [`PartitionName=${p.name}`];
    parts.push(`Nodes=${p.nodes}`);
    if (p.default) parts.push("Default=YES");
    parts.push(`MaxTime=${p.max_time || "INFINITE"}`);
    parts.push(`State=${p.state || "UP"}`);
    return parts.join(" ");
  }).join("\n");

  const script = `#!/bin/bash
set -euo pipefail

S=""; [ "$(id -u)" != "0" ] && S="sudo"

echo "============================================"
echo "  Applying ${partitions.length} partition(s) to slurm.conf"
echo "============================================"
echo ""

if ! $S ls /etc/slurm/slurm.conf >/dev/null 2>&1; then
  echo "[error] /etc/slurm/slurm.conf not found on controller — run Bootstrap first"
  exit 1
fi

# Ensure trailing newline
$S bash -c 'tail -c1 /etc/slurm/slurm.conf | read -r _ || echo "" >> /etc/slurm/slurm.conf'

# Remove all existing PartitionName= lines
$S sed -i '/^PartitionName=/d' /etc/slurm/slurm.conf
echo "[aura] Cleared existing PartitionName lines"

# Append new partition lines
$S bash -c 'cat >> /etc/slurm/slurm.conf' <<'PART_EOF'
${partitionLines}
PART_EOF

echo "[aura] Wrote new partitions:"
$S grep '^PartitionName=' /etc/slurm/slurm.conf | sed 's/^/  /'

echo ""
echo "[aura] Restarting slurmctld..."
$S systemctl restart slurmctld 2>&1 | tail -5 || true
sleep 2

echo "[aura] Current partition state:"
$S sinfo -o '%P %a %D %N' 2>&1 | head -20 || true

echo ""
echo "[aura] Partitions applied successfully"
`;

  (async () => {
    await appendLog(task.id, `[aura] Applying ${partitions.length} partition(s)`);
    const handle = sshExecScript(target, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          await appendLog(task.id, "\n[aura] Partitions applied successfully.");
          await logAudit({ action: "partitions.apply", entity: "Cluster", entityId: id, metadata: { count: partitions.length } });
        } else {
          await appendLog(task.id, "\n[aura] Failed to apply partitions or cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id });
}
