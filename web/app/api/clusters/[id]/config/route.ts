import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { unredactConfig } from "@/lib/redact-config";
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
  const { config: incoming } = body;

  if (!incoming) {
    return NextResponse.json(
      { error: "Missing required field: config" },
      { status: 400 }
    );
  }

  // The editor ships masked secrets. Merge the real values back in from the
  // stored config so the user doesn't accidentally zero them out.
  const config = unredactConfig(incoming, cluster.config);

  const updatedCluster = await prisma.cluster.update({
    where: { id },
    data: { config: config as any },
  });

  // Propagate to agent (non-blocking — long-running Ansible operation)
  const requestId = randomUUID();
  try {
    await publishCommand(id, {
      request_id: requestId,
      type: "propagate_config",
      payload: { config },
    });

    return NextResponse.json({
      cluster: updatedCluster,
      request_id: requestId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Config saved but propagation failed
    return NextResponse.json(
      {
        cluster: updatedCluster,
        warning: `Config saved but failed to queue propagation: ${message}`,
      },
      { status: 207 }
    );
  }
}
