import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecSimple } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

type Action = "hold" | "release" | "requeue";

const ACTION_CMD: Record<Action, string> = {
  hold: "scontrol hold",
  release: "scontrol release",
  requeue: "scontrol requeue",
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

  const cmd = `S=""; [ "$(id -u)" != "0" ] && S="sudo"; $S ${ACTION_CMD[action]} ${rawId} 2>&1`;

  const result = await sshExecSimple(
    {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
    },
    cmd,
  );

  await logAudit({
    action: `jobs.${action}`,
    entity: "Cluster",
    entityId: id,
    metadata: { slurmJobId: rawId, success: result.success },
  });

  return NextResponse.json({
    success: result.success,
    output: (result.stdout + result.stderr).trim() || `${action} ${rawId}: ok`,
    exitCode: result.exitCode,
  });
}
