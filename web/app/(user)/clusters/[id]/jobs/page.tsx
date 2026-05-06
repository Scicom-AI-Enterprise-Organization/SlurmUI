/**
 * Server component wrapper for the jobs listing page.
 *
 * The interactive table itself lives in `jobs-list-client.tsx` (a Client
 * Component). This file pre-fetches the default (page 1, no filters) jobs
 * payload server-side and passes it as `initialData` so the client renders
 * rows on the first paint instead of showing an empty shell while waiting
 * on a `fetch()` round-trip.
 *
 * The client component uses the seed to skip its initial mount-fetch when
 * the URL is in default state — without that skip, the server work was
 * duplicated by the immediate client fetch and the page paid 2× the
 * Prisma cost per request.
 */
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toJobListItems, type JobListInputRow } from "@/lib/job-list-transform";
import JobListPage, { type JobListInitialData } from "./jobs-list-client";

// Render this page on every request — never serve a cached response.
// The job table is per-user (non-admins see only their own jobs) and
// changes constantly as Slurm transitions states; a stale render would
// show the wrong rows or wrong status badges.
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface Props {
  params: Promise<{ id: string }>;
}

export default async function JobsListServerPage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/clusters/" + id + "/jobs");

  const userId = (session.user as { id?: string }).id ?? "";
  const role = (session.user as { role?: string }).role;
  const userScope = role !== "ADMIN" ? { userId } : {};

  // Same shape as GET /api/clusters/[id]/jobs default response. Kept in
  // sync by hand — duplicating the SQL is cheaper than an internal HTTP
  // round-trip from the server component to its own API.
  const limit = 20;
  let initialData: JobListInitialData | null = null;
  try {
    const where = { clusterId: id, ...userScope };
    const [jobs, total, partitionsRaw, configPartitionsRaw] = await Promise.all([
      prisma.job.findMany({
        where,
        orderBy: { createdAt: "desc" },
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
          script: true,
        },
      }),
      prisma.job.count({ where }),
      prisma.job.groupBy({
        by: ["partition"],
        where: { clusterId: id, ...userScope },
      }),
      prisma.$queryRaw<Array<{ partitions: string[] | null }>>`
        SELECT jsonb_path_query_array(config, '$.slurm_partitions[*].name') AS partitions
        FROM "Cluster" WHERE id = ${id}
      `,
    ]);

    const normalized = jobs.map((j) => ({
      ...j,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
    }));
    const withName = toJobListItems(normalized as unknown as JobListInputRow[]);
    const configPartitions = (configPartitionsRaw[0]?.partitions ?? [])
      .filter((p): p is string => typeof p === "string");
    const availablePartitions = Array.from(new Set([
      ...configPartitions,
      ...partitionsRaw.map((p) => p.partition),
    ])).filter(Boolean).sort();

    initialData = {
      jobs: withName as unknown as JobListInitialData["jobs"],
      pagination: {
        page: 1,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
      partitions: availablePartitions,
    };
  } catch {
    // Pre-fetch is best-effort. If it fails (DB hiccup, cluster missing),
    // fall through and let the client do its own fetch on mount.
    initialData = null;
  }

  return <JobListPage initialData={initialData ?? undefined} />;
}
