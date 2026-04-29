import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { submitJob } from "@/lib/submit-job";

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

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") ?? "1");
  const limit = parseInt(url.searchParams.get("limit") ?? "20");
  const skip = (page - 1) * limit;
  const nameFilter = (url.searchParams.get("name") ?? "").trim();
  const statusFilter = (url.searchParams.get("status") ?? "").trim();
  const partitionFilter = (url.searchParams.get("partition") ?? "").trim();
  const fromFilter = (url.searchParams.get("from") ?? "").trim();
  const toFilter = (url.searchParams.get("to") ?? "").trim();

  const where: Record<string, unknown> = { clusterId: id };
  if ((session.user as any).role !== "ADMIN") {
    where.userId = session.user.id;
  }
  if (statusFilter) where.status = statusFilter;
  if (partitionFilter) where.partition = partitionFilter;
  if (nameFilter) {
    // job-name lives inside the stored SBATCH script as `--job-name=<x>`
    // or `-J <x>`. Anchor to the SBATCH directive so the search matches
    // the derived name, not arbitrary words in the script body.
    where.OR = [
      { script: { contains: `--job-name=${nameFilter}`, mode: "insensitive" } },
      { script: { contains: `-J ${nameFilter}`, mode: "insensitive" } },
      { script: { contains: `-J=${nameFilter}`, mode: "insensitive" } },
    ];
  }
  if (fromFilter || toFilter) {
    const range: Record<string, Date> = {};
    if (fromFilter) {
      const d = new Date(fromFilter);
      if (!isNaN(d.getTime())) range.gte = d;
    }
    if (toFilter) {
      const d = new Date(toFilter);
      if (!isNaN(d.getTime())) {
        // "to" is inclusive for the whole day the user picked.
        d.setHours(23, 59, 59, 999);
        range.lte = d;
      }
    }
    if (Object.keys(range).length > 0) where.createdAt = range;
  }

  const [jobs, total, partitionsRaw, clusterRow] = await Promise.all([
    prisma.job.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit }),
    prisma.job.count({ where }),
    prisma.job.findMany({
      where: { clusterId: id, ...(((session.user as any).role !== "ADMIN") ? { userId: session.user.id } : {}) },
      distinct: ["partition"],
      select: { partition: true },
    }),
    prisma.cluster.findUnique({ where: { id }, select: { config: true } }),
  ]);

  // Derive job name from the stored SBATCH script so we can show a Name column.
  const nameRe = /#SBATCH\s+(?:--job-name|-J)[=\s]+(\S+)/;
  const withName = jobs.map((j) => {
    const m = j.script?.match(nameRe);
    return { ...j, name: m ? m[1] : null };
  });

  // Available partitions for the filter dropdown: union of (cluster-config
  // partitions) + (distinct partitions used by any past job).
  const cfg = (clusterRow?.config ?? {}) as Record<string, unknown>;
  const configPartitions = (cfg.slurm_partitions as Array<{ name: string }> | undefined)?.map((p) => p.name) ?? [];
  const availablePartitions = Array.from(new Set([
    ...configPartitions,
    ...partitionsRaw.map((p) => p.partition),
  ])).filter(Boolean).sort();

  return NextResponse.json({
    jobs: withName,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    partitions: availablePartitions,
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

  // All users (including admins) must be actively provisioned to submit jobs.
  const clusterUser = await prisma.clusterUser.findUnique({
    where: { userId_clusterId: { userId: session.user.id, clusterId: id } },
  });
  if (!clusterUser || clusterUser.status !== "ACTIVE") {
    return NextResponse.json(
      { error: "You must be provisioned on this cluster before submitting jobs." },
      { status: 403 }
    );
  }

  const body = await req.json();
  const { script, partition } = body;

  if (!script || !partition) {
    return NextResponse.json({ error: "Missing required fields: script, partition" }, { status: 400 });
  }

  try {
    const updated = await submitJob({
      clusterId: id,
      userId: session.user.id,
      script,
      partition,
    });
    return NextResponse.json(updated, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Job submission failed: ${message}` }, { status: 502 });
  }
}
