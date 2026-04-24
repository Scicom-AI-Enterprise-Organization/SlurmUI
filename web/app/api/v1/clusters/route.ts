/**
 * GET /api/v1/clusters — list clusters this caller can see.
 *
 * Non-admin callers only get back clusters they've been provisioned onto
 * (via ClusterUser with status=ACTIVE). Admins see everything.
 *
 * Response shape is intentionally minimal — enough to pick a cluster for
 * a subsequent job submit, nothing that would leak SSH keys / tokens.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getApiUser } from "@/lib/api-auth";

export async function GET(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const where = user.role === "ADMIN"
    ? {}
    : {
        clusterUsers: {
          some: { userId: user.id, status: "ACTIVE" },
        },
      };

  const clusters = await prisma.cluster.findMany({
    where,
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      connectionMode: true,
      status: true,
      sshBastion: true,
      createdAt: true,
      config: true,
    },
  });

  return NextResponse.json({
    clusters: clusters.map((c) => {
      const cfg = (c.config ?? {}) as Record<string, unknown>;
      const parts = (cfg.slurm_partitions ?? []) as Array<Record<string, unknown>>;
      const nodes = (cfg.slurm_nodes ?? []) as Array<Record<string, unknown>>;
      return {
        id: c.id,
        name: c.name,
        mode: c.connectionMode,
        status: c.status,
        bastion: c.sshBastion,
        createdAt: c.createdAt,
        partitions: parts.map((p) => p.name).filter((n) => typeof n === "string"),
        defaultPartition: (parts.find((p) => p.default === true)?.name as string | undefined) ?? (parts[0]?.name as string | undefined),
        nodeCount: nodes.length,
      };
    }),
  });
}
