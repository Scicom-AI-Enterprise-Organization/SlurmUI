import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { listTrackersFromConfig } from "@/lib/experiment-trackers";

interface RouteParams { params: Promise<{ id: string; trackerId: string }> }

// DELETE /api/clusters/[id]/integrations/[trackerId]
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id, trackerId } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = (cluster.config as Record<string, unknown>) ?? {};
  const trackers = listTrackersFromConfig(config);
  const target = trackers.find((t) => t.id === trackerId);
  if (!target) return NextResponse.json({ error: "Tracker not found" }, { status: 404 });

  const updated = trackers.filter((t) => t.id !== trackerId);
  await prisma.cluster.update({
    where: { id },
    data: { config: { ...config, experiment_trackers: updated } as never },
  });

  await logAudit({
    action: "integrations.tracker.remove",
    entity: "Cluster",
    entityId: id,
    metadata: { name: target.name, backend: target.backend },
  });

  return NextResponse.json({ ok: true });
}
