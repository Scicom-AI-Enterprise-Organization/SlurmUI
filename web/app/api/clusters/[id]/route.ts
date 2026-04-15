import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

  // Only admins see install token fields
  if ((session.user as any).role !== "ADMIN") {
    const { installToken, installTokenExpiresAt, installTokenUsedAt, ...safe } = cluster;
    return NextResponse.json(safe);
  }

  return NextResponse.json(cluster);
}

// PATCH /api/clusters/[id] — update cluster (admin only)
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { name, controllerHost, status, config } = body;

  const VALID_STATUSES = ["PROVISIONING", "ACTIVE", "DEGRADED", "OFFLINE", "ERROR"];
  if (status && !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const updated = await prisma.cluster.update({
    where: { id },
    data: {
      ...(name && { name }),
      ...(controllerHost && { controllerHost }),
      ...(status && { status }),
      ...(config && { config }),
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

  // Delete all dependent records before removing the cluster (FK constraints).
  await prisma.appSession.deleteMany({ where: { clusterId: id } });
  await prisma.job.deleteMany({ where: { clusterId: id } });
  await prisma.clusterUser.deleteMany({ where: { clusterId: id } });
  await prisma.cluster.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
