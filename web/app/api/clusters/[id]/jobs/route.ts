import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { submitJob } from "@/lib/submit-job";
import { effectiveClusterStatus } from "@/lib/cluster-health";
import { toJobListItems, type JobListInputRow } from "@/lib/job-list-transform";

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

  // Listing payload: select ONLY the columns the table renders. The
  // default `findMany` returns every column — including `output` (cached
  // job stdout, can be megabytes per row) and the full `script`. On a
  // cluster with a few hundred jobs that adds up to tens of MB per page
  // load. Browser only needs ~7 fields, plus enough of `script` to
  // extract the SBATCH job-name.
  //
  // Use `prisma.$transaction([...])` instead of `Promise.all([...])` so
  // all four reads run on a SINGLE connection (Prisma serialises them
  // inside the tx). With `Promise.all` Prisma grabs four connections
  // from the pool simultaneously — on a small pool (e.g. the 1-CPU-
  // container default `cpus*2+1 = 3`) the 4th query waits and the
  // page hangs for the full `pool_timeout`. Sequential-inside-tx is
  // only ~30 ms slower than fully-parallel on a warm DB but stays
  // pool-pressure-free.
  const [jobs, total, partitionsRaw, configPartitionsRaw] = await prisma.$transaction([
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
        createdAt: true,
        updatedAt: true,
        sourceName: true,
        // Stored job name (set on submit). The transform prefers this
        // over the script regex; we still read `script` as a fallback
        // for legacy rows whose `name` column wasn't backfilled.
        name: true,
        script: true,
        experimentRunUrl: true,
      },
    }),
    prisma.job.count({ where }),
    // groupBy is the indexed path for distinct partitions; `findMany +
    // distinct` does it client-side after fetching N rows. `orderBy` is
    // required by the typed-tuple form of `$transaction` (Prisma's
    // groupBy inside a tx has a stricter type than the same call inside
    // `Promise.all`).
    prisma.job.groupBy({
      by: ["partition"],
      where: {
        clusterId: id,
        ...(((session.user as any).role !== "ADMIN") ? { userId: session.user.id } : {}),
      },
      orderBy: { partition: "asc" },
    }),
    // Pull just `slurm_partitions[].name` out of the cluster config via a
    // JSONB path query. The full `config` JSONB on a configured cluster
    // is 50–500 KB (nodes / storage / packages / users / env vars) — we
    // were fetching all of that just to read the partition list.
    // jsonb_path_query_array returns a JSON string array; we cast the
    // result and unpack on the JS side.
    prisma.$queryRaw<Array<{ partitions: string[] | null }>>`
      SELECT jsonb_path_query_array(config, '$.slurm_partitions[*].name') AS partitions
      FROM "Cluster" WHERE id = ${id}
    `,
  ]);

  // Derive job name from the stored SBATCH script so we can show a Name
  // column, then drop the full script from the payload — the listing
  // page never displays it; the detail page fetches /jobs/<id> which
  // returns the full script. Helper lives in lib/job-list-transform so
  // the perf contract (no `script`/`output` in payload) is unit-tested.
  const withName = toJobListItems(jobs as unknown as JobListInputRow[]);

  // Available partitions for the filter dropdown: union of (cluster-config
  // partitions extracted via JSONB path) + (distinct partitions used by
  // any past job).
  const configPartitions = (configPartitionsRaw[0]?.partitions ?? [])
    .filter((p): p is string => typeof p === "string");
  const availablePartitions = Array.from(new Set([
    ...configPartitions,
    ...partitionsRaw.map((p: { partition: string }) => p.partition),
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

  // Use the probe-derived effective status, not the raw column. The DB
  // status is updated lazily (only flips OFFLINE after 2 consecutive
  // probe fails), so a single transient SSH timeout in prod can leave
  // status=OFFLINE in the DB even though the very next probe came back
  // alive. The UI already shows status from this same helper.
  const eff = effectiveClusterStatus(cluster);
  if (eff !== "ACTIVE" && eff !== "DEGRADED") {
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
  // Optional experiment-tracker selection from the new-job form.
  // Validation is loose at the wire layer; submitJob raises if the
  // tracker id doesn't exist on this cluster.
  const tracker =
    body.tracker && typeof body.tracker === "object" && typeof body.tracker.trackerId === "string"
      ? {
          trackerId: body.tracker.trackerId as string,
          experimentName: typeof body.tracker.experimentName === "string" ? body.tracker.experimentName : undefined,
          runName: typeof body.tracker.runName === "string" ? body.tracker.runName : undefined,
        }
      : undefined;
  // Optional Git credential id from the new-job form. Passed through
  // verbatim to submitJob, which understands three forms:
  //   undefined / missing → auto-pick (CLI convenience)
  //   "none"              → explicit opt-out
  //   <id>                → that specific credential
  const gitCredentialId =
    typeof body.gitCredentialId === "string" && body.gitCredentialId.trim()
      ? body.gitCredentialId.trim()
      : undefined;

  if (!script || !partition) {
    return NextResponse.json({ error: "Missing required fields: script, partition" }, { status: 400 });
  }

  try {
    const updated = await submitJob({
      clusterId: id,
      userId: session.user.id,
      script,
      partition,
      tracker,
      gitCredentialId,
    });
    return NextResponse.json(updated, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Job submission failed: ${message}` }, { status: 502 });
  }
}
