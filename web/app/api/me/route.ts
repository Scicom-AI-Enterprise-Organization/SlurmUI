import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { effectiveClusterStatus } from "@/lib/cluster-health";

// Profile endpoint — user fetches their own record + provisioned clusters.
// Does NOT expose keycloakId (auth-system-internal) or anything scoped to
// other users. Safe to call from the profile page without admin checks.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true, email: true, name: true, role: true,
      unixUsername: true, unixUid: true, unixGid: true,
      createdAt: true,
      passwordHash: true,
    },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  // Expose "hasPassword" so the profile page knows whether to show the
  // reset-password form (local-login users only). Never leak the hash.
  const hasPassword = !!user.passwordHash;
  const { passwordHash: _pw, ...userSafe } = user;

  const clusterUsers = await prisma.clusterUser.findMany({
    where: { userId: user.id },
    include: { cluster: { select: { id: true, name: true, status: true, config: true } } },
    orderBy: { provisionedAt: "desc" },
  });

  const [jobCount, runningCount, templateCount] = await Promise.all([
    prisma.job.count({ where: { userId: user.id } }),
    prisma.job.count({ where: { userId: user.id, status: { in: ["PENDING", "RUNNING"] } } }),
    prisma.jobTemplate.count({ where: { userId: user.id } }),
  ]);

  return NextResponse.json({
    user: userSafe,
    hasPassword,
    // Trust the live probe (config.health.alive) over the DB status
    // column — the column is updated lazily by the periodic monitor and
    // can lag the probe by a cycle, which made the Profile page show
    // ACTIVE clusters as OFFLINE while /api/clusters showed them green.
    clusters: clusterUsers.map((cu) => ({
      id: cu.cluster.id,
      name: cu.cluster.name,
      clusterStatus: effectiveClusterStatus({
        status: cu.cluster.status,
        config: (cu.cluster.config ?? {}) as Record<string, unknown>,
      }),
      status: cu.status,
      provisionedAt: cu.provisionedAt,
    })),
    stats: { jobCount, runningCount, templateCount },
  });
}
