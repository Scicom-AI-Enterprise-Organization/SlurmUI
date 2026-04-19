import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";

interface RouteParams { params: Promise<{ id: string }> }
interface HostEntry { hostname: string; ip: string; user?: string; port?: number }

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

// POST /api/clusters/[id]/nodes/fix — unstick a node.
//   Kills any CG/R jobs pinned to the node, restarts slurmd on the node, then
//   flips the node State DOWN → RESUME so slurmctld re-evaluates it.
//   Uses sshExecScript so the whole thing runs as a single non-interactive
//   bash script (no PTY marker games, no sudo password prompts).
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const nodeName = (body.nodeName ?? "").trim();
  if (!nodeName || !/^[A-Za-z0-9._-]+$/.test(nodeName)) {
    return NextResponse.json({ error: "Invalid nodeName" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey) {
    return NextResponse.json({ error: "Cluster not reachable" }, { status: 412 });
  }

  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const target = hostsEntries.find((h) => h.hostname === nodeName);
  const nodeIp = target?.ip ?? nodeName;
  const nodeUser = target?.user ?? "root";
  const nodePort = target?.port ?? 22;

  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: "node_fix" },
  });

  const sshTarget = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const script = `#!/bin/bash
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo -n"

echo "============================================"
echo "  Fixing node: ${nodeName}"
echo "============================================"
echo ""

echo "[1/4] Current state:"
$S scontrol show node ${nodeName} 2>&1 | grep -E 'State=|Reason=|NodeAddr=' | sed 's/^/  /'
echo ""

echo "[2/4] Killing jobs pinned to ${nodeName}..."
JOBS=$(squeue -h -o '%.18i %R %T' 2>/dev/null | awk -v n="${nodeName}" '$2 ~ n {print $1}')
if [ -n "$JOBS" ]; then
  for j in $JOBS; do
    echo "  scancel --signal=KILL --full $j"
    $S scancel --signal=KILL --full "$j" 2>&1 | sed 's/^/    /'
  done
else
  echo "  (no jobs pinned to this node)"
fi
echo ""

echo "[3/4] Marking node DOWN + RESUME (clears stuck CG / DRAIN / MIXED)..."
$S scontrol update NodeName=${nodeName} State=DOWN Reason='aura fix' 2>&1 | sed 's/^/  /'
sleep 2
$S scontrol update NodeName=${nodeName} State=RESUME 2>&1 | sed 's/^/  /'
echo ""

echo "[4/4] New state:"
$S scontrol show node ${nodeName} 2>&1 | grep -E 'State=|Reason=|NodeAddr=' | sed 's/^/  /'
echo ""

# Optional slurmd restart on the target node — best-effort, short timeout so
# we don't hang if the controller can't reach it. Main fix is the state flip
# above; this is just belt-and-suspenders for wedged slurmd.
echo "[note] Attempting slurmd restart on ${nodeName} (best-effort, 5s timeout)..."
timeout 5 ssh -n -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 -p ${nodePort} ${nodeUser}@${nodeIp} 'sudo -n systemctl restart slurmd 2>&1' 2>&1 | head -3 | sed 's/^/  /' || echo "  (skipped — could not reach node)"
echo ""

echo "[aura] Fix complete."
`;

  (async () => {
    await appendLog(task.id, `[aura] Fixing node ${nodeName}`);
    const handle = sshExecScript(sshTarget, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          await appendLog(task.id, "\n[aura] Node fix succeeded.");
          await logAudit({ action: "node.fix", entity: "Cluster", entityId: id, metadata: { nodeName } });
        } else {
          await appendLog(task.id, "\n[aura] Node fix failed or was cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id });
}
