import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/install-token — regenerate install token (admin only)
export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const installToken = randomUUID();
  const installTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);

  const updated = await prisma.cluster.update({
    where: { id },
    data: { installToken, installTokenExpiresAt, installTokenUsedAt: null },
  });

  return NextResponse.json({ installToken: updated.installToken, installTokenExpiresAt: updated.installTokenExpiresAt });
}
