import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

type Action = "hold" | "release" | "requeue" | "terminate";

const ACTION_CMD: Record<Action, string> = {
  hold: "scontrol hold",
  release: "scontrol release",
  requeue: "scontrol requeue",
  // --signal=KILL --full forces SIGKILL on every task without waiting for
  // KillWait. Without this the job lingers in CG state and resources stay
  // reserved, which users interpret as "cancel didn't work".
  terminate: "scancel --signal=KILL --full",
};

// POST /api/clusters/[id]/slurm-control
// Admin-only. Runs scontrol hold/release/requeue on raw Slurm job ids from
// the queue view. Goes through sudo since the shared SSH user isn't the job
// owner — Slurm lets root modify any job.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json()) as { slurmJobId?: unknown; action?: unknown };
  const rawId = String(body.slurmJobId ?? "");
  const action = body.action as Action;
  if (!/^[0-9]+(_[0-9]+)?$/.test(rawId)) {
    return NextResponse.json({ error: "Invalid slurmJobId" }, { status: 400 });
  }
  if (!ACTION_CMD[action]) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });
  if (cluster.connectionMode !== "SSH") {
    return NextResponse.json({ error: "Only supported in SSH mode" }, { status: 400 });
  }

  // Bastion sessions drop an interactive shell that echoes a welcome banner
  // and closing lines. Use sshExecScript (which base64-pipes scripts on
  // bastions) + markers so we can cleanly slice scontrol's output.
  const marker = `__SCTL_${Date.now()}__`;
  const script = `#!/bin/bash
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"
echo "${marker}_START"
$S ${ACTION_CMD[action]} ${rawId} 2>&1
ec=$?
echo "${marker}_END:$ec"
`;

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };
  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });

  const blob = chunks.join("\n");
  const start = blob.indexOf(`${marker}_START`);
  const endMatch = blob.match(new RegExp(`${marker}_END:(\\d+)`));
  const cmdExit = endMatch ? parseInt(endMatch[1], 10) : null;
  const end = endMatch ? blob.indexOf(endMatch[0]) : -1;
  const cleanOutput = start !== -1 && end !== -1
    ? blob.slice(start + `${marker}_START`.length, end).trim()
    : "";

  const success = cmdExit === 0;

  await logAudit({
    action: `jobs.${action}`,
    entity: "Cluster",
    entityId: id,
    metadata: { slurmJobId: rawId, success },
  });

  return NextResponse.json({
    success,
    output: cleanOutput || `${action} ${rawId}: ok`,
    exitCode: cmdExit,
  });
}
