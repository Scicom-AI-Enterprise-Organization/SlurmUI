import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/clusters/[id]/jobs — list jobs
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const where: Record<string, unknown> = { clusterId: id };

  // Non-admin users only see their own jobs
  if ((session.user as any).role !== "ADMIN") {
    where.userId = session.user.id;
  }

  // Support pagination
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") ?? "1");
  const limit = parseInt(url.searchParams.get("limit") ?? "20");
  const skip = (page - 1) * limit;

  const [jobs, total] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.job.count({ where }),
  ]);

  return NextResponse.json({
    jobs,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
}

// POST /api/clusters/[id]/jobs — submit a job
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  if (cluster.status !== "ACTIVE" && cluster.status !== "DEGRADED") {
    return NextResponse.json(
      { error: "Cluster is not accepting jobs" },
      { status: 503 }
    );
  }

  const body = await req.json();
  const { script, partition } = body;

  if (!script || !partition) {
    return NextResponse.json(
      { error: "Missing required fields: script, partition" },
      { status: 400 }
    );
  }

  // Create job in database
  const job = await prisma.job.create({
    data: {
      clusterId: id,
      userId: session.user.id,
      script,
      partition,
      status: "PENDING",
    },
  });

  // Submit to agent via NATS
  try {
    const result = await sendCommand(id, {
      request_id: job.id,
      command: "sbatch",
      args: {
        script,
        partition,
        job_id: job.id,
        user_id: session.user.id,
      },
    }) as { slurm_job_id?: number };

    // Update job with Slurm job ID
    const updatedJob = await prisma.job.update({
      where: { id: job.id },
      data: {
        slurmJobId: result.slurm_job_id ?? null,
        status: "RUNNING",
      },
    });

    return NextResponse.json(updatedJob, { status: 201 });
  } catch (err) {
    // Mark job as failed
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "FAILED" },
    });

    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Job submission failed: ${message}`, job },
      { status: 502 }
    );
  }
}
