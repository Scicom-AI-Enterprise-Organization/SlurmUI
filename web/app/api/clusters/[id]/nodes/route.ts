import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/clusters/[id]/nodes — list nodes (via sinfo on agent)
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  if (cluster.status === "OFFLINE") {
    return NextResponse.json(
      { error: "Cluster is offline" },
      { status: 503 }
    );
  }

  try {
    const result = await sendCommand(id, {
      request_id: randomUUID(),
      command: "sinfo",
      args: { format: "json" },
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to fetch nodes: ${message}` },
      { status: 504 }
    );
  }
}
