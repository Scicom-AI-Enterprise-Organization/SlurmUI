import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/nodes/activate — activate a FUTURE node
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
    return NextResponse.json(
      { error: "Missing required field: nodeName" },
      { status: 400 }
    );
  }

  try {
    const result = await sendCommand(id, {
      request_id: randomUUID(),
      command: "activate_node",
      args: {
        target_node: nodeName,
        config: cluster.config,
      },
    }, 120000); // 2 min timeout for ansible operations

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to activate node: ${message}` },
      { status: 504 }
    );
  }
}
