import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = (session.user as { role?: string }).role === "ADMIN";
  const userId = session.user.id;
  const scope = isAdmin ? {} : { userId };

  const { searchParams } = request.nextUrl;
  const clusterIdParam = searchParams.get("clusterId") || undefined;
  const clusterFilter = clusterIdParam ? { clusterId: clusterIdParam } : {};

  const [partitionRows, userRows, clusterRows] = await prisma.$transaction([
    prisma.job.findMany({
      where: { ...scope, ...clusterFilter },
      select: { partition: true },
      distinct: ["partition"],
      orderBy: { partition: "asc" },
    }),
    isAdmin
      ? prisma.user.findMany({
          select: { id: true, name: true, unixUsername: true },
          orderBy: [{ name: "asc" }],
        })
      : prisma.user.findMany({
          where: { id: userId },
          select: { id: true, name: true, unixUsername: true },
        }),
    prisma.cluster.findMany({
      select: { id: true, name: true, config: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // Extract node lists per partition from cluster config JSON
  const partitionNodes: Record<string, string[]> = {};
  for (const cluster of clusterRows) {
    if (!clusterIdParam || cluster.id === clusterIdParam) {
      const config = cluster.config as Record<string, unknown> | null;
      const partitions = (config?.partitions as Array<{ name: string; nodes?: string[] }>) ?? [];
      for (const p of partitions) {
        if (p.name && p.nodes?.length) {
          partitionNodes[p.name] = [...(partitionNodes[p.name] ?? []), ...p.nodes];
        }
      }
    }
  }

  return NextResponse.json({
    partitions: partitionRows.map((r) => r.partition),
    partitionNodes,
    users: userRows.map((u) => ({
      id: u.id,
      name: u.name,
      unixUsername: u.unixUsername,
    })),
  });
}
