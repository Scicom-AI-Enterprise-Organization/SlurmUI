import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { submitJob } from "@/lib/submit-job";
import { appendTaskLog } from "@/lib/task-log";
import { sshExecScript } from "@/lib/ssh-exec";

interface P { params: Promise<{ id: string; jobId: string }> }

// Fresh submit of the same script + partition (or an edited script when
// `body.script` is provided). Used for FAILED jobs that never acquired a
// slurmJobId, for the per-row "Restart" button on the jobs list, and for
// the Job-detail "Edit script & Resubmit" flow.
//
// Optional body:
//   {
//     script?: string,         // override the stored script
//     cancelCurrent?: boolean, // scancel the original if it's RUNNING/PENDING
//   }
//
// Non-admins can only resubmit their own jobs. GitOps-only clusters still
// reject the call because the submit helper's sourceRef guard kicks in.
//
// Returns { taskId } immediately; submitJob runs in the background and
// streams SSH output into the BackgroundTask's logs column so the UI can
// show a live log dialog. The actual Job row is linked via a task log
// line once submitJob resolves.
export async function POST(req: NextRequest, { params }: P) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as { script?: string; cancelCurrent?: boolean };
  const overrideScript = typeof body.script === "string" && body.script.trim().length > 0 ? body.script : null;
  const cancelCurrent = body.cancelCurrent === true;

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
  if (overrideScript) {
    await appendTaskLog(task.id, `[aura] Using edited script (${overrideScript.length} bytes).`);
  }

  // Fire and forget — submitJob handles its own SSH session and DB updates.
  // We tee log lines into the task so the client can poll /api/tasks/<id>.
  (async () => {
    try {
      // Optional pre-step: scancel the source job before submitting the new
      // one. We only run this when the caller asks (the Edit-script flow
      // does; a plain Restart historically didn't cancel anything).
      if (cancelCurrent && job.slurmJobId && (job.status === "RUNNING" || job.status === "PENDING")) {
        const cluster = await prisma.cluster.findUnique({
          where: { id },
          include: { sshKey: true },
        });
        if (cluster?.connectionMode === "SSH" && cluster.sshKey) {
          await appendTaskLog(task.id, `[aura] Cancelling running job (slurm ${job.slurmJobId})…`);
          const target = {
            host: cluster.controllerHost,
            user: cluster.sshUser,
            port: cluster.sshPort,
            privateKey: cluster.sshKey.privateKey,
            bastion: cluster.sshBastion,
          };
          // Same scancel script as the DELETE handler — sudo fallback so
          // cancelling someone else's job (admin path) still works.
          const cancelScript = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT
OUT=$(scancel --signal=KILL --full ${job.slurmJobId} 2>&1)
RC=$?
echo "$OUT"
if [ $RC -eq 0 ]; then echo "[scancel-ok] cancelled by $(id -un)"; exit 0; fi
echo "[scancel-retry] retrying with sudo -n"
sudo -n scancel --signal=KILL --full ${job.slurmJobId} 2>&1
exit $?
`;
          await new Promise<void>((resolve) => {
            sshExecScript(target, cancelScript, {
              onStream: (line) => {
                const trimmed = line.replace(/\r/g, "").trim();
                if (trimmed) appendTaskLog(task.id, trimmed);
              },
              onComplete: () => resolve(),
            });
          });
          await prisma.job.update({ where: { id: job.id }, data: { status: "CANCELLED" } });
        } else {
          await appendTaskLog(task.id, `[aura] Skipping scancel — cluster isn't in SSH mode.`);
        }
      }

      const created = await submitJob({
        clusterId: id,
        userId: job.userId,
        script: overrideScript ?? job.script,
        partition: job.partition,
        auditExtra: { resubmitOf: job.id, edited: !!overrideScript, cancelCurrent },
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
