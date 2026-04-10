import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/nodes/activate — activate a FUTURE node (non-blocking)
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  const body = await req.json();
  const { nodeName } = body;

  if (!nodeName) {
    return NextResponse.json({ error: "Missing required field: nodeName" }, { status: 400 });
  }

  const requestId = randomUUID();

  try {
    await publishCommand(id, {
      request_id: requestId,
      type: "activate_node",
      payload: {
        target_node: nodeName,
        config: cluster.config,
      },
    });

    return NextResponse.json({ request_id: requestId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
