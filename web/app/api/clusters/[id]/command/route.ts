import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/command — send command to agent
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Verify cluster exists
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  if (cluster.status === "OFFLINE") {
    return NextResponse.json(
      { error: "Cluster is offline. Cannot send commands." },
      { status: 503 }
    );
  }

  const body = await req.json();
  const { command, args, timeout } = body;

  if (!command) {
    return NextResponse.json(
      { error: "Missing required field: command" },
      { status: 400 }
    );
  }

  const requestId = randomUUID();
  const timeoutMs = timeout ?? 30000;

  try {
    const result = await sendCommand(id, {
      request_id: requestId,
      command,
      args: args ?? {},
      user: session.user.id,
      timestamp: new Date().toISOString(),
    }, timeoutMs);

    return NextResponse.json({
      request_id: requestId,
      result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Command failed: ${message}`, request_id: requestId },
      { status: 504 }
    );
  }
}
