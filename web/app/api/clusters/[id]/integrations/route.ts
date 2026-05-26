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
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { listTrackersFromConfig } from "@/lib/experiment-trackers";
import type { ExperimentTracker, TrackerBackend } from "@/lib/experiment-trackers/types";
import { randomBytes } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

const SUPPORTED_BACKENDS: TrackerBackend[] = ["mlflow", "wandb"];

function genId(): string {
  return `exp-${randomBytes(8).toString("hex")}`;
}

// GET /api/clusters/[id]/integrations
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    select: { config: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  // Redact passwords on read — the form treats blank as "no change" on
  // PATCH (TODO when we add update). Surface a hasPassword bool so the UI
  // can show "configured" vs "(none)" without ever shipping the secret.
  const trackers = listTrackersFromConfig(cluster.config as Record<string, unknown> | null)
    .map((t) => {
      const { password, ...rest } = t;
      return { ...rest, hasPassword: !!(password && password.length > 0) };
    });
  return NextResponse.json({ trackers });
}

// POST /api/clusters/[id]/integrations
// body: { name, backend, trackingUri, defaultExperimentName?, username?, password? }
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
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
  // Optional basic-auth credentials. Trim username (whitespace is never
  // meaningful); preserve password byte-for-byte since access keys can
  // legitimately contain trailing characters that look like whitespace.
  const username =
    typeof body.username === "string" && body.username.trim()
      ? body.username.trim()
      : undefined;
  const password =
    typeof body.password === "string" && body.password.length > 0
      ? body.password
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
    username,
    password,
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
    // Never write the password into audit metadata — the audit log is
    // joinable into the UI's activity feed, and Basic-auth creds shouldn't
    // surface there. hasPassword/hasUsername give an admin enough breadcrumb
    // to know the tracker was configured with auth without leaking it.
    metadata: {
      name, backend, trackingUri,
      hasUsername: !!username,
      hasPassword: !!password,
    },
  });

  // Strip password from the response too so the form doesn't echo it back.
  const { password: _pw, ...trackerSafe } = tracker;
  return NextResponse.json({
    tracker: { ...trackerSafe, hasPassword: !!password },
  }, { status: 201 });
}
