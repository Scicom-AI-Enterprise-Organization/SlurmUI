/**
 * Experiment-tracker integrations CRUD.
 *
 * Trackers live in cluster.config.experiment_trackers — same storage
 * pattern as storage_mounts and nfs_servers, so we don't need a separate
 * Prisma table for what's effectively per-cluster configuration. Admin
 * only (job submission read-back surface is a separate, narrower
 * endpoint — Phase 1 the new-job page just reads cluster.config directly
 * via the existing PATCH/GET endpoints).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { listTrackersFromConfig } from "@/lib/experiment-trackers";
import type { ExperimentTracker, TrackerBackend } from "@/lib/experiment-trackers/types";
import { randomBytes } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

const SUPPORTED_BACKENDS: TrackerBackend[] = ["mlflow"]; // Phase 1

function genId(): string {
  return `exp-${randomBytes(8).toString("hex")}`;
}

// GET /api/clusters/[id]/integrations
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    select: { config: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const trackers = listTrackersFromConfig(cluster.config as Record<string, unknown> | null);
  return NextResponse.json({ trackers });
}

// POST /api/clusters/[id]/integrations
// body: { name, backend, trackingUri, defaultExperimentName? }
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const backend = body.backend as TrackerBackend;
  const trackingUri = typeof body.trackingUri === "string" ? body.trackingUri.trim() : "";
  const defaultExperimentName =
    typeof body.defaultExperimentName === "string" && body.defaultExperimentName.trim()
      ? body.defaultExperimentName.trim()
      : undefined;

  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!SUPPORTED_BACKENDS.includes(backend)) {
    return NextResponse.json(
      { error: `Unsupported backend '${backend}'. Phase 1 supports: ${SUPPORTED_BACKENDS.join(", ")}.` },
      { status: 400 },
    );
  }
  if (!/^https?:\/\//i.test(trackingUri)) {
    return NextResponse.json(
      { error: "trackingUri must start with http:// or https://" },
      { status: 400 },
    );
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = (cluster.config as Record<string, unknown>) ?? {};
  const existing = listTrackersFromConfig(config);
  if (existing.some((t) => t.name === name)) {
    return NextResponse.json(
      { error: `A tracker named '${name}' already exists on this cluster.` },
      { status: 409 },
    );
  }

  const tracker: ExperimentTracker = {
    id: genId(),
    name,
    backend,
    trackingUri,
    defaultExperimentName,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  const updated = [...existing, tracker];
  await prisma.cluster.update({
    where: { id },
    // Cast: ExperimentTracker[] isn't structurally InputJsonValue (Prisma
    // wants an index signature), but Postgres jsonb stores it fine.
    data: { config: { ...config, experiment_trackers: updated } as never },
  });

  await logAudit({
    action: "integrations.tracker.create",
    entity: "Cluster",
    entityId: id,
    metadata: { name, backend, trackingUri },
  });

  return NextResponse.json({ tracker }, { status: 201 });
}
