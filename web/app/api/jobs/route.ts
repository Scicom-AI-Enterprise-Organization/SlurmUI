import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/jobs — list current user's jobs across all clusters (paginated).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20")));
  const skip = (page - 1) * limit;

  const nameFilter = (url.searchParams.get("name") ?? "").trim();
  const statusFilter = (url.searchParams.get("status") ?? "").trim();
  const partitionFilter = (url.searchParams.get("partition") ?? "").trim();
  const clusterFilter = (url.searchParams.get("cluster") ?? "").trim();
  const fromFilter = (url.searchParams.get("from") ?? "").trim();
  const toFilter = (url.searchParams.get("to") ?? "").trim();

  const where: Record<string, unknown> = {};
  if ((session.user as any).role !== "ADMIN") {
    where.userId = session.user.id;
  }
  if (statusFilter) where.status = statusFilter;
  if (partitionFilter) where.partition = partitionFilter;
  if (clusterFilter) where.clusterId = clusterFilter;
  if (nameFilter) where.script = { contains: nameFilter, mode: "insensitive" };
  if (fromFilter || toFilter) {
    const range: Record<string, Date> = {};
    if (fromFilter) {
      const d = new Date(fromFilter);
      if (!isNaN(d.getTime())) range.gte = d;
    }
    if (toFilter) {
      const d = new Date(toFilter);
      if (!isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999);
        range.lte = d;
      }
    }
    if (Object.keys(range).length > 0) where.createdAt = range;
  }

  const scopeWhere = {
    ...((session.user as any).role !== "ADMIN" ? { userId: session.user.id } : {}),
  };

  const [jobs, total, partitionsRaw, clustersRaw] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: { cluster: { select: { name: true } } },
    }),
    prisma.job.count({ where }),
    prisma.job.findMany({
      where: scopeWhere,
      distinct: ["partition"],
      select: { partition: true },
    }),
    prisma.job.findMany({
      where: scopeWhere,
      distinct: ["clusterId"],
      select: { clusterId: true, cluster: { select: { name: true } } },
    }),
  ]);

  const nameRe = /#SBATCH\s+(?:--job-name|-J)[=\s]+(\S+)/;
  const withName = jobs.map((j) => {
    const m = j.script?.match(nameRe);
    return { ...j, name: m ? m[1] : null };
  });

  const availablePartitions = partitionsRaw.map((p) => p.partition).filter(Boolean).sort();
  const availableClusters = clustersRaw
    .map((c) => ({ id: c.clusterId, name: c.cluster?.name ?? c.clusterId.slice(0, 8) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({
    jobs: withName,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    partitions: availablePartitions,
    clusters: availableClusters,
  });
}
