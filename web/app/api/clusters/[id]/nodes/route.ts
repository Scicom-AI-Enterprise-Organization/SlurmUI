import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommandAndWait } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/clusters/[id]/nodes — list nodes via sinfo on agent
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

  if (cluster.status === "OFFLINE" || cluster.status === "PROVISIONING") {
    return NextResponse.json({ error: "Cluster is not available" }, { status: 503 });
  }

  try {
    const result = await sendCommandAndWait(
      id,
      { request_id: randomUUID(), type: "node_status" },
      30_000
    ) as { stdout?: string; Stdout?: string; exitCode?: number };

    // Agent returns ExecResult with stdout containing raw sinfo --json output.
    const raw = result.stdout ?? result.Stdout ?? "";
    try {
      const sinfo = JSON.parse(raw) as { nodes?: unknown[]; partitions?: unknown[] };
      return NextResponse.json({ nodes: sinfo.nodes ?? [], partitions: sinfo.partitions ?? [] });
    } catch {
      // If parsing fails, return raw for debugging
      return NextResponse.json({ nodes: [], raw, error: "Failed to parse sinfo JSON" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Failed to fetch nodes: ${message}` }, { status: 504 });
  }
}
