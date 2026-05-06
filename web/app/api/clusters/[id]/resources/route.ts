import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

interface NodeRow {
  host: string;
  state: string;
  cpuAlloc: number;
  cpuTotal: number;
  memTotalMb: number;
  memFreeMb: number;
  gpuTotal: number;
  gpuUsed: number;
}

function parseGres(s: string): number {
  // Matches "gpu:2", "gpu:a100:4", "gpu:a100:4(IDX:0-3)". Sum multiple entries
  // from comma-separated list.
  if (!s || s === "(null)" || s === "null") return 0;
  let total = 0;
  for (const part of s.split(",")) {
    const m = part.match(/gpu(?::[^:]+)?:(\d+)/);
    if (m) total += parseInt(m[1], 10);
  }
  return total;
}

// GET /api/clusters/[id]/resources — live CPU / memory / GPU availability
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

  const MARKER = `__RES_${Date.now()}__`;
  // We use AllocMem (memory committed to running jobs) instead of FreeMem
  // (OS-level free RAM from /proc/meminfo). On a healthy Linux box FreeMem
  // is always near zero because the kernel reuses unallocated RAM for the
  // page / FS cache — it would make a node with 4 GB of jobs running on
  // an 85 GB machine look 98% full, which is exactly the bug we're
  // fixing. memFree below is then RealMemory − AllocMem, which matches
  // Slurm's own scheduling view of "how much can a new job request here".
  const script = `
echo "${MARKER}_START"
sinfo -N -h -O "NodeHost:|,StateLong:|,CPUsState:|,Memory:|,AllocMem:|,Gres:200|,GresUsed:200|" 2>/dev/null
echo "${MARKER}_END"
`;

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });

  const full = chunks.join("\n");
  const start = full.indexOf(`${MARKER}_START`);
  const end = full.indexOf(`${MARKER}_END`);
  const body = start !== -1 && end !== -1
    ? full.slice(start + `${MARKER}_START`.length, end).trim()
    : "";

  const seen = new Set<string>();
  const nodes: NodeRow[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 7) continue;
    const [host, state, cpuState, memTotal, memAlloc, gres, gresUsed] = parts;
    if (!host || seen.has(host)) continue;
    seen.add(host);

    // cpuState is "alloc/idle/other/total" — take alloc and total.
    const cs = cpuState.split("/");
    const cpuAlloc = parseInt(cs[0] ?? "0", 10) || 0;
    const cpuTotal = parseInt(cs[3] ?? "0", 10) || 0;
    const memTotalMb = parseInt(memTotal, 10) || 0;
    const memAllocMb = parseInt(memAlloc, 10) || 0;
    // Free as Slurm sees it: total node memory minus what's been promised
    // to running jobs. Clamp at zero in case of accounting drift.
    const memFreeMb = Math.max(0, memTotalMb - memAllocMb);

    nodes.push({
      host,
      state,
      cpuAlloc,
      cpuTotal,
      memTotalMb,
      memFreeMb,
      gpuTotal: parseGres(gres),
      gpuUsed: parseGres(gresUsed),
    });
  }

  // Idle-ish states contribute free capacity. Drained / down nodes count
  // toward total but not toward free.
  const isLiveState = (s: string) => {
    const x = s.toLowerCase();
    return !x.includes("down") && !x.includes("drain") && !x.includes("fail") &&
      !x.includes("maint") && !x.includes("boot");
  };

  const totals = nodes.reduce(
    (acc, n) => {
      acc.cpuTotal += n.cpuTotal;
      acc.memTotalMb += n.memTotalMb;
      acc.gpuTotal += n.gpuTotal;
      if (isLiveState(n.state)) {
        acc.cpuFree += Math.max(0, n.cpuTotal - n.cpuAlloc);
        acc.memFreeMb += n.memFreeMb;
        acc.gpuFree += Math.max(0, n.gpuTotal - n.gpuUsed);
      }
      return acc;
    },
    { cpuTotal: 0, cpuFree: 0, memTotalMb: 0, memFreeMb: 0, gpuTotal: 0, gpuFree: 0 },
  );

  return NextResponse.json({
    nodes,
    totals,
    fetchedAt: new Date().toISOString(),
  });
}
