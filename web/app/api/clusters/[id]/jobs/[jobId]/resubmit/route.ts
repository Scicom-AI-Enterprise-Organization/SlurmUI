import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { submitJob } from "@/lib/submit-job";
import { appendTaskLog } from "@/lib/task-log";

interface P { params: Promise<{ id: string; jobId: string }> }

// Fresh submit of the same script + partition. Used for FAILED jobs that
// never acquired a slurmJobId (sbatch rejected, SSH blew up, etc.) — for
// those `scontrol requeue` is a no-op, so we create a new Job row instead.
//
// Non-admins can only resubmit their own jobs. GitOps-only clusters still
// reject the call because the submit helper's sourceRef guard kicks in.
//
// Returns { taskId } immediately; submitJob runs in the background and
// streams SSH output into the BackgroundTask's logs column so the UI can
// show a live log dialog. The actual Job row is linked via a task log
// line once submitJob resolves.
export async function POST(_req: NextRequest, { params }: P) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const job = await prisma.job.findFirst({
    where: {
      id: jobId,
      clusterId: id,
      ...((session.user as any).role !== "ADMIN" ? { userId: session.user.id } : {}),
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: "resubmit_job" },
  });
  await appendTaskLog(task.id, `[aura] Resubmitting job ${job.id.slice(0, 8)}...`);

  // Fire and forget — submitJob handles its own SSH session and DB updates.
  // We tee log lines into the task so the client can poll /api/tasks/<id>.
  (async () => {
    try {
      const created = await submitJob({
        clusterId: id,
        userId: job.userId,
        script: job.script,
        partition: job.partition,
        auditExtra: { resubmitOf: job.id },
        onLogLine: (line) => {
          const trimmed = line.replace(/\r/g, "").trim();
          if (trimmed) appendTaskLog(task.id, trimmed);
        },
      });
      await appendTaskLog(task.id, `\n[aura] Resubmitted as job ${created.id.slice(0, 8)}${created.slurmJobId ? ` (slurm ${created.slurmJobId})` : ""}.`);
      await appendTaskLog(task.id, `__AURA_RESUBMIT_JOB_ID__=${created.id}`);
      await prisma.backgroundTask.update({
        where: { id: task.id },
        data: { status: "success", completedAt: new Date() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      await appendTaskLog(task.id, `\n[aura] Resubmit failed: ${message}`);
      await prisma.backgroundTask.update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date() },
      });
    }
  })();

  return NextResponse.json({ taskId: task.id }, { status: 202 });
}
