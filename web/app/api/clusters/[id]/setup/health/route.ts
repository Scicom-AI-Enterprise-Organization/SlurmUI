import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "node_status",
    payload: {},
  });

  return NextResponse.json({ request_id: requestId });
}
