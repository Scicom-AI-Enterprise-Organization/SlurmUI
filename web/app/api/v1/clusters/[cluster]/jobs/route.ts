/**
 * Public v1 jobs endpoints.
 *
 *   POST /api/v1/clusters/:cluster/jobs   — submit a job
 *   GET  /api/v1/clusters/:cluster/jobs   — list jobs (scoped to the token owner
 *                                           unless the caller is ADMIN)
 *
 * The `:cluster` path segment accepts either the cluster's UUID or its `name`
 * — whichever is handier for curl. Names are resolved first, UUID fallback.
 *
 * Authentication: NextAuth session OR Authorization: Bearer <token>, resolved
 * via `getApiUser` in `lib/api-auth.ts`. VIEWER users can list but not submit.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { submitJob } from "@/lib/submit-job";
import { getApiUser } from "@/lib/api-auth";

interface RouteParams { params: Promise<{ cluster: string }> }

async function resolveCluster(clusterIdent: string) {
  // Try UUID-ish first (cheap lookup), then by name.
  const byId = await prisma.cluster.findUnique({ where: { id: clusterIdent } });
  if (byId) return byId;
  return prisma.cluster.findFirst({ where: { name: clusterIdent } });
}

// GET — list jobs. Query params: page, limit (≤100), status, partition, name,
// from, to (ISO dates). Non-admins see only their own jobs.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { cluster: clusterIdent } = await params;
  const cluster = await resolveCluster(clusterIdent);
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { clusterId: cluster.id };
  if (user.role !== "ADMIN") where.userId = user.id;

  const nameFilter = (url.searchParams.get("name") ?? "").trim();
  const statusFilter = (url.searchParams.get("status") ?? "").trim().toUpperCase();
  const partitionFilter = (url.searchParams.get("partition") ?? "").trim();
  const from = (url.searchParams.get("from") ?? "").trim();
  const to = (url.searchParams.get("to") ?? "").trim();

  if (statusFilter) where.status = statusFilter;
  if (partitionFilter) where.partition = partitionFilter;
  if (nameFilter) where.script = { contains: nameFilter, mode: "insensitive" };
  if (from || to) {
    const range: Record<string, Date> = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    where.createdAt = range;
  }

  const [total, rows] = await Promise.all([
    prisma.job.count({ where }),
    prisma.job.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      select: {
        id: true,
        slurmJobId: true,
        clusterId: true,
        userId: true,
        partition: true,
        status: true,
        exitCode: true,
        sourceName: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  return NextResponse.json({
    jobs: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

// POST — submit a job. Body:
//   { script: string, partition?: string, name?: string }
// `name` is cosmetic; if provided we inject a `#SBATCH --job-name=` header
// when the script doesn't already have one.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "VIEWER") {
    return NextResponse.json({ error: "VIEWER role cannot submit jobs" }, { status: 403 });
  }

  const { cluster: clusterIdent } = await params;
  const cluster = await resolveCluster(clusterIdent);
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  let body: { script?: string; partition?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const script = (body.script ?? "").trim();
  if (!script) return NextResponse.json({ error: "`script` is required" }, { status: 400 });

  const partition = (body.partition ?? "").trim() || resolveDefaultPartition(cluster);
  if (!partition) {
    return NextResponse.json({ error: "No partition specified and no default partition on the cluster" }, { status: 400 });
  }

  // Optional cosmetic job-name — inject as #SBATCH --job-name= when missing.
  let finalScript = script;
  if (body.name && !/^#SBATCH\s+--job-name=/m.test(script)) {
    const lines = script.split("\n");
    const shebangIdx = lines[0]?.startsWith("#!") ? 0 : -1;
    lines.splice(shebangIdx + 1, 0, `#SBATCH --job-name=${body.name.trim()}`);
    finalScript = lines.join("\n");
  }

  try {
    const job = await submitJob({
      clusterId: cluster.id,
      userId: user.id,
      script: finalScript,
      partition,
      // Pass the explicit `body.name` through so submitJob doesn't have
      // to re-extract from the script (and so the validation error
      // message references the value the API caller actually sent).
      name: body.name?.trim() || undefined,
      auditExtra: { via: "api/v1", tokenId: user.tokenId },
    });
    return NextResponse.json({
      id: job.id,
      slurmJobId: job.slurmJobId,
      clusterId: job.clusterId,
      partition: job.partition,
      status: job.status,
      createdAt: job.createdAt,
    }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Submit failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function resolveDefaultPartition(cluster: { config: unknown }): string {
  const cfg = (cluster.config ?? {}) as Record<string, unknown>;
  const parts = (cfg.slurm_partitions ?? []) as Array<Record<string, unknown>>;
  const def = parts.find((p) => p.default === true);
  if (def && typeof def.name === "string") return def.name;
  if (parts.length > 0 && typeof parts[0].name === "string") return parts[0].name as string;
  return "";
}
