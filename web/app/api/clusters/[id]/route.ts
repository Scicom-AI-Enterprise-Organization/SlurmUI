import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { redactConfig } from "@/lib/redact-config";
import { probeClusterHealth } from "@/lib/cluster-health";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/clusters/[id] — cluster detail
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: {
      _count: {
        select: { jobs: true },
      },
    },
  });

  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  // Kick off a debounced background liveness probe. Updates cluster.status
  // to OFFLINE when SSH fails (e.g. VMs deleted), ACTIVE when it recovers.
  // The current GET still returns the stale status — next refresh sees truth.
  probeClusterHealth(id);

  // Redact secret config values (S3 keys, passwords, etc.) before sending.
  const redacted = { ...cluster, config: redactConfig(cluster.config) };

  // Only admins see install token fields
  if ((session.user as any).role !== "ADMIN") {
    const { installToken, installTokenExpiresAt, installTokenUsedAt, ...safe } = redacted;
    return NextResponse.json(safe);
  }

  return NextResponse.json(redacted);
}

// PATCH /api/clusters/[id] — update cluster (admin only)
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { name, controllerHost, status, config, sshUser, sshPort, sshBastion, sshKeyId, sshJumpHost, sshJumpUser, sshJumpPort, sshJumpKeyId, sshProxyCommand, sshJumpProxyCommand } = body;

  const VALID_STATUSES = ["PROVISIONING", "ACTIVE", "DEGRADED", "OFFLINE", "ERROR"];
  if (status && !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
  }

  if (sshKeyId) {
    const sshKey = await prisma.sshKey.findUnique({ where: { id: sshKeyId } });
    if (!sshKey) return NextResponse.json({ error: "SSH key not found" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  // Merge config fields into existing config instead of replacing
  let mergedConfig = undefined;
  if (config) {
    const existingConfig = (cluster.config ?? {}) as Record<string, unknown>;
    mergedConfig = { ...existingConfig, ...config };
  }

  const updated = await prisma.cluster.update({
    where: { id },
    data: {
      ...(name && { name }),
      ...(controllerHost && { controllerHost }),
      ...(status && { status }),
      ...(mergedConfig && { config: mergedConfig }),
      ...(sshUser !== undefined && { sshUser }),
      ...(sshPort !== undefined && { sshPort }),
      ...(sshBastion !== undefined && { sshBastion }),
      ...(sshKeyId && { sshKeyId }),
      // Jump fields — accept explicit null/empty-string to clear, otherwise
      // apply. When sshJumpHost is set to empty, also wipe the companions so
      // we don't leave orphaned user/port/key values in the DB.
      ...(sshJumpHost !== undefined && {
        sshJumpHost: sshJumpHost || null,
        sshJumpUser: sshJumpHost ? (sshJumpUser || "root") : null,
        sshJumpPort: sshJumpHost ? (sshJumpPort || 22) : null,
        sshJumpKeyId: sshJumpHost && sshJumpKeyId ? sshJumpKeyId : null,
      }),
      ...(sshJumpHost === undefined && sshJumpUser !== undefined && { sshJumpUser }),
      ...(sshJumpHost === undefined && sshJumpPort !== undefined && { sshJumpPort }),
      ...(sshJumpHost === undefined && sshJumpKeyId !== undefined && { sshJumpKeyId: sshJumpKeyId || null }),
      ...(sshProxyCommand !== undefined && { sshProxyCommand: sshProxyCommand || null }),
      ...(sshJumpProxyCommand !== undefined && { sshJumpProxyCommand: sshJumpProxyCommand || null }),
    },
  });

  return NextResponse.json(updated);
}

// DELETE /api/clusters/[id] — delete cluster (admin only)
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id }, select: { name: true } });

  // Delete all dependent records before removing the cluster (FK constraints).
  await prisma.appSession.deleteMany({ where: { clusterId: id } });
  await prisma.job.deleteMany({ where: { clusterId: id } });
  await prisma.clusterUser.deleteMany({ where: { clusterId: id } });
  await prisma.cluster.delete({ where: { id } });

  await logAudit({
    action: "cluster.delete",
    entity: "Cluster",
    entityId: id,
    metadata: { name: cluster?.name },
  });

  return NextResponse.json({ success: true });
}
