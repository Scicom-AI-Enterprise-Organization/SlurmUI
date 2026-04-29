/**
 * GET /api/clusters/[id]/proxies — list every job in this cluster with a
 * proxyPort configured. Used by the cluster-level Proxies tab.
 *
 * Visibility:
 *   - ADMIN: every job
 *   - non-admin user (active ClusterUser or job submitter): every proxy in
 *     the cluster they can see (i.e. proxies they own + proxies of others
 *     who are also active members). Mirrors the metrics tab's "we share a
 *     cluster, we share dashboards" posture rather than per-job ACLs.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = (session.user as { id?: string }).id;
  const role = (session.user as { role?: string }).role;
  if (role !== "ADMIN") {
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const cu = await prisma.clusterUser.findFirst({
      where: { clusterId: id, userId, status: "ACTIVE" as const },
      select: { id: true },
    });
    if (!cu) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const jobs = await prisma.job.findMany({
    where: { clusterId: id, proxyPort: { not: null } },
    select: {
      id: true,
      slurmJobId: true,
      userId: true,
      script: true,
      partition: true,
      status: true,
      proxyPort: true,
      proxyName: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });

  const userIds = Array.from(new Set(jobs.map((j) => j.userId)));
  const users = userIds.length === 0 ? [] : await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, name: true, unixUsername: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  const items = jobs.map((j) => {
    const m = j.script?.match(/#SBATCH\s+(?:--job-name|-J)[=\s]+(\S+)/);
    const jobName = m ? m[1] : `Job ${j.id.slice(0, 8)}`;
    const u = userMap.get(j.userId);
    return {
      id: j.id,
      slurmJobId: j.slurmJobId,
      jobName,
      partition: j.partition,
      status: j.status,
      proxyPort: j.proxyPort,
      proxyName: j.proxyName,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      user: u ? { id: u.id, email: u.email, name: u.name, unixUsername: u.unixUsername } : null,
    };
  });

  return NextResponse.json({ proxies: items });
}
