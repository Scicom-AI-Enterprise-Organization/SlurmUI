import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { submitJob } from "@/lib/submit-job";

interface P { params: Promise<{ id: string; jobId: string }> }

// Fresh submit of the same script + partition. Used for FAILED jobs that
// never acquired a slurmJobId (sbatch rejected, SSH blew up, etc.) — for
// those `scontrol requeue` is a no-op, so we create a new Job row instead.
//
// Non-admins can only resubmit their own jobs. GitOps-only clusters still
// reject the call because the submit helper's sourceRef guard kicks in.
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

  try {
    const created = await submitJob({
      clusterId: id,
      userId: job.userId,
      script: job.script,
      partition: job.partition,
      auditExtra: { resubmitOf: job.id },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Resubmit failed: ${message}` }, { status: 502 });
  }
}
