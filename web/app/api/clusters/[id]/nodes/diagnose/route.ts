import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";
import { appendTaskLog } from "@/lib/task-log";

interface RouteParams { params: Promise<{ id: string }> }
interface HostEntry { hostname: string; ip: string; user?: string; port?: number }

// Diagnose's onStream fires many lines very fast — naive fire-and-forget
// UPDATEs race in Postgres and arrive out of order in the dialog. Route
// through the per-task queue helper so order is strict.
const appendLog = (taskId: string, line: string) => appendTaskLog(taskId, line);

async function finishTask(taskId: string, success: boolean) {
  await prisma.backgroundTask.update({
    where: { id: taskId },
    data: { status: success ? "success" : "failed", completedAt: new Date() },
  });
}

// POST — read-only health probe on a single node. Checks network reachability,
// port 6818 (slurmd), node-side slurmd status, chrony time sync, recent
// slurmd log lines. No state changes.
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
    data: { clusterId: id, type: "node_diagnose" },
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
echo "  Diagnosing: ${nodeName} (${nodeIp})"
echo "============================================"
echo ""

echo "[1/6] scontrol view of this node:"
$S scontrol show node ${nodeName} 2>&1 | grep -E 'State=|Reason=|NodeAddr=|NodeHostName=|CPULoad=|RealMemory=|AllocMem=' | sed 's/^/  /'
echo ""

echo "[2/6] Ping ${nodeIp} (3 packets)..."
ping -c 3 -W 2 ${nodeIp} 2>&1 | tail -5 | sed 's/^/  /'
echo ""

echo "[3/6] TCP reachability to slurmd port 6818..."
timeout 5 bash -c '</dev/tcp/${nodeIp}/6818' 2>&1 && echo "  OK — slurmd port open" || echo "  FAIL — port 6818 not reachable (firewall? slurmd down?)"
# Also probe via hostname since slurmctld uses NodeHostName:
NODE_HOSTNAME=$($S scontrol show node ${nodeName} 2>/dev/null | grep -oP 'NodeHostName=\\K\\S+' | head -1)
if [ -n "$NODE_HOSTNAME" ] && [ "$NODE_HOSTNAME" != "${nodeIp}" ]; then
  echo "  Also trying via NodeHostName=$NODE_HOSTNAME..."
  timeout 5 bash -c "</dev/tcp/$NODE_HOSTNAME/6818" 2>&1 && echo "    OK" || echo "    FAIL (this is what slurmctld uses)"
fi
echo ""

echo "[4/6] slurmd status on the node (via SSH)..."
timeout 10 ssh -n -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 -p ${nodePort} ${nodeUser}@${nodeIp} '
  echo "  Uptime: $(uptime)"
  echo "  slurmd:"
  S=""; [ "$(id -u)" != "0" ] && S="sudo -n"
  $S systemctl is-active slurmd && echo "    active" || echo "    NOT active"
  $S systemctl status slurmd --no-pager -l 2>&1 | head -15 | sed "s/^/    /"
  echo ""
  echo "  slurmd process state (D = stuck in I/O, likely NFS/s3fs):"
  ps -eo pid,stat,comm | grep -E "\\bslurmd\\b|PID" | head -5 | sed "s/^/    /"
' 2>&1 | sed 's/^/  /' || echo "  (SSH unreachable — node may be down or key missing)"
echo ""

echo "[5/6] Chrony time sync on the node..."
timeout 10 ssh -n -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 -p ${nodePort} ${nodeUser}@${nodeIp} '
  if command -v chronyc >/dev/null; then
    chronyc tracking 2>&1 | grep -E "Reference ID|System time|Last offset|RMS offset" | sed "s/^/    /"
  else
    echo "    (chronyc not available)"
  fi
' 2>&1 | sed 's/^/  /' || true
echo ""

echo "[6/6] Last 15 slurmd log lines on the node..."
timeout 10 ssh -n -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 -p ${nodePort} ${nodeUser}@${nodeIp} '
  S=""; [ "$(id -u)" != "0" ] && S="sudo -n"
  $S journalctl -u slurmd -n 15 --no-pager 2>&1 || $S tail -n 15 /var/log/slurm/slurmd.log 2>&1
' 2>&1 | sed 's/^/  /' || true
echo ""

echo "[aura] Diagnosis complete."
`;

  (async () => {
    await appendLog(task.id, `[aura] Diagnosing node ${nodeName}`);
    const handle = sshExecScript(sshTarget, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        await appendLog(task.id, success ? "\n[aura] Done." : "\n[aura] Diagnosis cancelled.");
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id });
}
