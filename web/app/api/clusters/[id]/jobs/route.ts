import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommandAndWait, publishCommand } from "@/lib/nats";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/clusters/[id]/jobs — list jobs from DB
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const where: Record<string, unknown> = { clusterId: id };
  if ((session.user as any).role !== "ADMIN") {
    where.userId = session.user.id;
  }

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") ?? "1");
  const limit = parseInt(url.searchParams.get("limit") ?? "20");
  const skip = (page - 1) * limit;

  const [jobs, total] = await Promise.all([
    prisma.job.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit }),
    prisma.job.count({ where }),
  ]);

  return NextResponse.json({
    jobs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

// POST /api/clusters/[id]/jobs — submit a Slurm job
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
    return NextResponse.json({ error: "Cluster is not accepting jobs" }, { status: 503 });
  }

  // Verify the submitting user is provisioned and ACTIVE on this cluster.
  const dbUser = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Admins bypass the cluster-user check (they may not have a Linux account).
  const isAdmin = (session.user as any).role === "ADMIN";
  if (!isAdmin) {
    const clusterUser = await prisma.clusterUser.findUnique({
      where: { userId_clusterId: { userId: session.user.id, clusterId: id } },
    });
    if (!clusterUser || clusterUser.status !== "ACTIVE") {
      return NextResponse.json(
        { error: "You must be provisioned on this cluster before submitting jobs." },
        { status: 403 }
      );
    }
  }

  const body = await req.json();
  const { script, partition } = body;

  if (!script || !partition) {
    return NextResponse.json({ error: "Missing required fields: script, partition" }, { status: 400 });
  }

  // Create job record first so we have an ID for tracking
  const job = await prisma.job.create({
    data: { clusterId: id, userId: session.user.id, script, partition, status: "PENDING" },
  });

  try {
    const config = cluster.config as Record<string, unknown>;
    const outputDir = (config.mgmt_nfs_path as string | undefined) ?? "";
    // Derive username — same logic as provisioning. Falls back to empty string
    // for admins who may not have a Linux account (sbatch runs as root).
    const username = dbUser.unixUsername ?? "";

    const result = await sendCommandAndWait(
      id,
      {
        request_id: job.id,
        type: "submit_job",
        payload: {
          script,
          partition,
          job_name: `aura-${job.id.slice(0, 8)}`,
          output_dir: outputDir,
          username,
        },
      },
      60_000 // sbatch is fast
    ) as { slurm_job_id?: number; output_file?: string };

    const updated = await prisma.job.update({
      where: { id: job.id },
      data: { slurmJobId: result.slurm_job_id ?? null, status: "RUNNING" },
    });

    // Fire-and-forget: stream the job output file via the same request ID.
    // The WS subscriber on the job page will pick up the streamed lines.
    if (result.slurm_job_id && result.output_file) {
      publishCommand(id, {
        request_id: job.id,
        type: "watch_job",
        payload: {
          slurm_job_id: result.slurm_job_id,
          output_file: result.output_file,
        },
      }).catch((err) => console.error("[jobs] Failed to dispatch watch_job:", err));
    }

    return NextResponse.json(updated, { status: 201 });
  } catch (err) {
    await prisma.job.update({ where: { id: job.id }, data: { status: "FAILED" } });
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Job submission failed: ${message}`, job }, { status: 502 });
  }
}
