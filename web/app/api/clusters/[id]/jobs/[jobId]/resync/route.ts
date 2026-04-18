import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple } from "@/lib/ssh-exec";
import { logAudit } from "@/lib/audit";

interface RouteParams { params: Promise<{ id: string; jobId: string }> }

type Status = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

// POST /api/clusters/[id]/jobs/[jobId]/resync
// Pull the job's live state from Slurm (squeue then sacct) and overwrite the
// DB status. Meant for fixing rows stuck in the wrong state — e.g. when the
// watcher falsely marked a long-running job COMPLETED after an SSH hiccup.
export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.clusterId !== id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN" && job.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!job.slurmJobId) {
    return NextResponse.json({ error: "Job has no Slurm id" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey || cluster.connectionMode !== "SSH") {
    return NextResponse.json({ error: "Not available for this cluster" }, { status: 412 });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const sid = job.slurmJobId;
  const cmd =
    `echo "__SQUEUE__"; squeue -j ${sid} -h -o '%T|%r' 2>/dev/null; ` +
    `echo "__SACCT__"; sacct -j ${sid} -n -P -o State,ExitCode 2>/dev/null | head -1`;

  const result = await sshExecSimple(target, cmd);
  const out = result.stdout;
  const [beforeSacct, afterSacct = ""] = out.split("__SACCT__");
  const squeueBlock = (beforeSacct.split("__SQUEUE__")[1] ?? "").trim();
  const sacctBlock = afterSacct.trim();

  let status: Status | null = null;
  let exitCode: number | null = job.exitCode;
  let source: "squeue" | "sacct" | "none" = "none";

  if (squeueBlock) {
    const state = (squeueBlock.split("|")[0] ?? "").toUpperCase();
    if (state === "RUNNING" || state === "COMPLETING") status = "RUNNING";
    else if (state === "PENDING" || state === "CONFIGURING") status = "PENDING";
    else if (state === "SUSPENDED") status = "RUNNING";
    source = "squeue";
  } else if (sacctBlock) {
    const [rawState, rawExit] = sacctBlock.split("|");
    const state = (rawState ?? "").trim().toUpperCase();
    if (state === "COMPLETED") status = "COMPLETED";
    else if (state === "RUNNING") status = "RUNNING";
    else if (state === "PENDING") status = "PENDING";
    else if (state.startsWith("CANCELLED")) status = "CANCELLED";
    else if (state) status = "FAILED";
    const m = (rawExit ?? "").match(/(\d+):/);
    if (m) exitCode = parseInt(m[1], 10);
    source = "sacct";
  }

  if (!status) {
    return NextResponse.json({
      updated: false,
      previous: job.status,
      source,
      squeue: squeueBlock,
      sacct: sacctBlock,
      error: "Slurm returned no state — accounting unavailable or job expired from records",
    });
  }

  await prisma.job.update({
    where: { id: jobId },
    data: { status, exitCode },
  });

  await logAudit({
    action: "job.resync",
    entity: "Job",
    entityId: jobId,
    metadata: { previous: job.status, next: status, source, slurmJobId: sid },
  });

  return NextResponse.json({
    updated: job.status !== status,
    previous: job.status,
    next: status,
    exitCode,
    source,
  });
}
