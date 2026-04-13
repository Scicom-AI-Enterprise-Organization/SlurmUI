import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ id: string; userId: string }> }

// PATCH /api/clusters/[id]/users/[userId] — update provisioning status after SSE reply
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, userId } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { status } = await req.json();
  if (!["ACTIVE", "FAILED"].includes(status)) {
    return NextResponse.json({ error: "status must be ACTIVE or FAILED" }, { status: 400 });
  }

  const clusterUser = await prisma.clusterUser.update({
    where: { userId_clusterId: { userId, clusterId: id } },
    data: {
      status,
      provisionedAt: status === "ACTIVE" ? new Date() : undefined,
    },
  });

  return NextResponse.json(clusterUser);
}
