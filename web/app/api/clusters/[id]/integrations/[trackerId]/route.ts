import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { listTrackersFromConfig } from "@/lib/experiment-trackers";
import type { ExperimentTracker } from "@/lib/experiment-trackers/types";

interface RouteParams { params: Promise<{ id: string; trackerId: string }> }

// DELETE /api/clusters/[id]/integrations/[trackerId]
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id, trackerId } = await params;
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
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

// PATCH /api/clusters/[id]/integrations/[trackerId]
// body: { name?, trackingUri?, defaultExperimentName?, username?, password?, enabled? }
// Only the fields present are touched — passing "" explicitly *clears* a
// string field (use this to remove the password). To keep the existing
// password unchanged, omit the key entirely.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, trackerId } = await params;
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = (cluster.config as Record<string, unknown>) ?? {};
  const trackers = listTrackersFromConfig(config);
  const idx = trackers.findIndex((t) => t.id === trackerId);
  if (idx === -1) return NextResponse.json({ error: "Tracker not found" }, { status: 404 });

  const current = trackers[idx];
  const patch: Partial<ExperimentTracker> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.trackingUri === "string" && body.trackingUri.trim()) {
    if (!/^https?:\/\//i.test(body.trackingUri)) {
      return NextResponse.json({ error: "trackingUri must start with http:// or https://" }, { status: 400 });
    }
    patch.trackingUri = body.trackingUri.trim();
  }
  if (typeof body.defaultExperimentName === "string") {
    patch.defaultExperimentName = body.defaultExperimentName.trim() || undefined;
  }
  if (typeof body.username === "string") {
    patch.username = body.username.trim() || undefined;
  }
  if (typeof body.password === "string") {
    // "" clears it; non-empty replaces.
    patch.password = body.password.length > 0 ? body.password : undefined;
  }
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  const updated: ExperimentTracker = { ...current, ...patch };
  trackers[idx] = updated;

  await prisma.cluster.update({
    where: { id },
    data: { config: { ...config, experiment_trackers: trackers } as never },
  });

  await logAudit({
    action: "integrations.tracker.update",
    entity: "Cluster",
    entityId: id,
    metadata: {
      name: updated.name,
      backend: updated.backend,
      changed: Object.keys(patch),
      // Don't echo the new password — just whether it was set/cleared.
      passwordChanged: "password" in patch,
    },
  });

  const { password: _pw, ...safe } = updated;
  return NextResponse.json({
    tracker: { ...safe, hasPassword: !!updated.password },
  });
}
