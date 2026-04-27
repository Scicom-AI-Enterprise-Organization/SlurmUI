import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

// GET /api/clusters/[id]/alloc-debug — run the three "who holds the CPUs?"
// commands against the controller and return them bucketed so the Jobs page
// can render each under its own heading in a collapsible panel.
//
// Commands (same ones in the README's diagnostic block):
//   scontrol show job -dd                       # NumCPUs, MinCPUsNode, Gres, JobState
//   scontrol show node                          # CPUAlloc, AllocTRES per node
//   squeue -o "%.8i %.9P %.10j %.8u %.10T %.10M %.6D %.6C %.10m %.14b %R"
//                                            STATE         CPUs    MinMem  TresPerNode  Reason
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey || cluster.connectionMode !== "SSH") {
    return NextResponse.json({ error: "Not available for this cluster" }, { status: 412 });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const M = `__ALLOC_${Date.now()}__`;
  const script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

S=""; [ "$(id -u)" != "0" ] && S="sudo -n"

echo "${M}_JOBS_START"
$S scontrol show job -dd 2>&1 || scontrol show job -dd 2>&1
echo "${M}_JOBS_END"

echo "${M}_NODES_START"
$S scontrol show node 2>&1 || scontrol show node 2>&1
echo "${M}_NODES_END"

echo "${M}_SQUEUE_START"
# %T = State (RUNNING/PENDING/...), %C = CPUs, %m = MinMemory (MB),
# %b = TresPerNode (e.g. gres:gpu:N), %R = Reason
squeue -o "%.8i %.9P %.10j %.8u %.10T %.10M %.6D %.6C %.10m %.14b %R" 2>&1
echo "${M}_SQUEUE_END"

echo "${M}_CONF_START"
$S grep -E '^(SelectType|SelectTypeParameters|NodeName|PartitionName)' /etc/slurm/slurm.conf 2>&1 || grep -E '^(SelectType|SelectTypeParameters|NodeName|PartitionName)' /etc/slurm/slurm.conf 2>&1
echo "${M}_CONF_END"
`;

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      timeoutMs: 60 * 1000,
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });

  const full = chunks.join("\n");
  const extract = (section: string) => {
    const s = full.indexOf(`${M}_${section}_START`);
    const e = full.indexOf(`${M}_${section}_END`);
    if (s === -1 || e === -1) return "";
    return full.slice(s + `${M}_${section}_START`.length, e).replace(/^\n/, "").replace(/\n$/, "");
  };

  return NextResponse.json({
    jobs: extract("JOBS"),
    nodes: extract("NODES"),
    squeue: extract("SQUEUE"),
    conf: extract("CONF"),
    fetchedAt: new Date().toISOString(),
  });
}
