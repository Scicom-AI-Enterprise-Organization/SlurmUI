/**
 * POST /api/v1/jobs/:id/resync — re-query Slurm for the live state of a job
 * and overwrite the DB row.
 *
 * Needed when the tail-based job watcher misses a terminal transition (long
 * SSH hiccup, output file on an unmounted shared path, etc.) — the row
 * gets stuck in RUNNING even after Slurm has completed the job. Same logic
 * as the UI's "Resync state" button, just token-authenticated.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sshExecSimple } from "@/lib/ssh-exec";
import { logAudit } from "@/lib/audit";
import { getApiUser } from "@/lib/api-auth";

interface RouteParams { params: Promise<{ id: string }> }

type Status = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export async function POST(req: NextRequest, { params }: RouteParams) {
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (user.role !== "ADMIN" && job.userId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!job.slurmJobId) {
    return NextResponse.json({ error: "Job has no Slurm id" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id: job.clusterId },
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
    where: { id },
    data: { status, exitCode },
  });

  await logAudit({
    action: "job.resync",
    entity: "Job",
    entityId: id,
    metadata: { previous: job.status, next: status, source, slurmJobId: sid, via: "api/v1", tokenId: user.tokenId },
  });

  return NextResponse.json({
    updated: job.status !== status,
    previous: job.status,
    next: status,
    exitCode,
    source,
  });
}
