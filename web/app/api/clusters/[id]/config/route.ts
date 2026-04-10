import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/config — update and propagate config
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
  const { config } = body;

  if (!config) {
    return NextResponse.json(
      { error: "Missing required field: config" },
      { status: 400 }
    );
  }

  // Save config to database
  const updatedCluster = await prisma.cluster.update({
    where: { id },
    data: { config },
  });

  // Propagate to agent
  try {
    const result = await sendCommand(id, {
      request_id: randomUUID(),
      command: "propagate_config",
      args: { config },
    }, 120000);

    return NextResponse.json({
      cluster: updatedCluster,
      propagation: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Config saved but propagation failed
    return NextResponse.json(
      {
        cluster: updatedCluster,
        propagation: { error: message },
        warning: "Config saved but propagation to cluster failed. Retry propagation.",
      },
      { status: 207 }
    );
  }
}
