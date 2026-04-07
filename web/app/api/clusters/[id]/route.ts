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

  const cluster = await prisma.cluster.update({
    where: { id },
    data: {
      ...(name && { name }),
      ...(controllerHost && { controllerHost }),
      ...(status && { status }),
      ...(config && { config }),
    },
  });

  return NextResponse.json(cluster);
}

// DELETE /api/clusters/[id] — delete cluster (admin only)
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Delete all jobs first
  await prisma.job.deleteMany({ where: { clusterId: id } });
  await prisma.cluster.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
