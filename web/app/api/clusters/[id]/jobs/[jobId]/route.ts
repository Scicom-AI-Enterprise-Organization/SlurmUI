import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommandAndWait } from "@/lib/nats";
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

  return NextResponse.json(job);
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

  // Send cancel command to agent (best effort)
  if (job.slurmJobId) {
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

  const updatedJob = await prisma.job.update({
    where: { id: jobId },
    data: { status: "CANCELLED" },
  });

  return NextResponse.json(updatedJob);
}
