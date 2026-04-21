import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sendCommandAndWait } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string; jobId: string }>;
}

// GET /api/clusters/[id]/jobs/[jobId] — job detail
export async function GET(req: NextRequest, { params }: RouteParams) {
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
    include: {
      cluster: {
        select: { name: true, status: true },
      },
    },
  });

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Job has no Prisma relation back to User (kept out of the schema to avoid
  // cascading migration churn), so fetch it separately and splice into the
  // response so the detail page can show who submitted.
  const user = await prisma.user.findUnique({
    where: { id: job.userId },
    select: { email: true, name: true, unixUsername: true },
  });

  // If job is running, optionally fetch latest status from agent
  if (job.status === "RUNNING" && job.slurmJobId && job.cluster.status !== "OFFLINE") {
    try {
      const result = await sendCommandAndWait(id, {
        request_id: randomUUID(),
        type: "job_info",
        payload: { job_id: String(job.slurmJobId) },
      }, 10000) as { state?: string; exit_code?: number };

      // Update local status if changed
      if (result.state) {
        const statusMap: Record<string, string> = {
          COMPLETED: "COMPLETED",
          FAILED: "FAILED",
          CANCELLED: "CANCELLED",
          RUNNING: "RUNNING",
          PENDING: "PENDING",
        };
        const newStatus = statusMap[result.state] ?? job.status;
        if (newStatus !== job.status) {
          await prisma.job.update({
            where: { id: jobId },
            data: {
              status: newStatus as any,
              exitCode: result.exit_code ?? null,
            },
          });
          job.status = newStatus as any;
          job.exitCode = result.exit_code ?? null;
        }
      }
    } catch {
      // Agent unreachable — return cached data
    }
  }

  return NextResponse.json({ ...job, user });
}

// DELETE /api/clusters/[id]/jobs/[jobId] — cancel job
export async function DELETE(req: NextRequest, { params }: RouteParams) {
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

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.status !== "RUNNING" && job.status !== "PENDING") {
    return NextResponse.json(
      { error: "Job is not running or pending" },
      { status: 400 }
    );
  }

  // Actually kill the Slurm job. In SSH mode the NATS path below is a
  // no-op (no agent), so we were just flipping the DB row to CANCELLED
  // while the job kept running in the queue. Run scancel directly over
  // SSH, matching what the gitops reconciler does.
  if (job.slurmJobId) {
    const cluster = await prisma.cluster.findUnique({
      where: { id },
      include: { sshKey: true },
    });

    if (cluster?.connectionMode === "SSH" && cluster.sshKey) {
      const target = {
        host: cluster.controllerHost,
        user: cluster.sshUser,
        port: cluster.sshPort,
        privateKey: cluster.sshKey.privateKey,
        bastion: cluster.sshBastion,
      };
      // --signal=KILL + --full sends SIGKILL to every step (sbatch wrapper
      // + the user's batch shell) without waiting for KillWait. Try as the
      // ssh user first; fall back to sudo -n so root can cancel any job.
      const script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT
OUT=$(scancel --signal=KILL --full ${job.slurmJobId} 2>&1)
RC=$?
echo "$OUT"
if [ $RC -eq 0 ]; then
  echo "[scancel-ok] job ${job.slurmJobId} cancelled by $(id -un)"
  exit 0
fi
echo "[scancel-retry] retrying with sudo -n"
sudo -n scancel --signal=KILL --full ${job.slurmJobId} 2>&1
SUDO_RC=$?
if [ $SUDO_RC -eq 0 ]; then
  echo "[scancel-ok] job ${job.slurmJobId} cancelled via sudo"
  exit 0
fi
echo "[scancel-fail] scancel rc=$RC sudo rc=$SUDO_RC"
exit 1
`;
      await new Promise<void>((resolve) => {
        sshExecScript(target, script, {
          onStream: () => {},
          onComplete: () => resolve(),
        });
      });
    } else {
      // NATS mode
      try {
        await sendCommandAndWait(id, {
          request_id: randomUUID(),
          type: "cancel_job",
          payload: { job_id: String(job.slurmJobId) },
        }, 15000);
      } catch {
        // Best effort — still mark as cancelled locally
      }
    }
  }

  const updatedJob = await prisma.job.update({
    where: { id: jobId },
    data: { status: "CANCELLED" },
  });

  await logAudit({
    action: "job.cancel",
    entity: "Job",
    entityId: jobId,
    metadata: { clusterId: id, slurmJobId: job.slurmJobId },
  });

  return NextResponse.json(updatedJob);
}
