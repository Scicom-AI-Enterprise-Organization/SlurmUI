/**
 * Test Connection on an unsaved tracker (Add Tracker form's "Test" button).
 *
 * We deliberately don't persist anything here — the form takes the result
 * and decides whether to allow the actual create. Same shape as the
 * /storage/test endpoint.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { adapterFor } from "@/lib/experiment-trackers";
import type { ExperimentTracker, TrackerBackend } from "@/lib/experiment-trackers/types";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, _ctx: RouteParams) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const backend = body.backend as TrackerBackend;
  const trackingUri = typeof body.trackingUri === "string" ? body.trackingUri.trim() : "";

  // Synthetic tracker — the adapter doesn't need the persisted id/name
  // for testConnection.
  const tracker: ExperimentTracker = {
    id: "test",
    name: "test",
    backend,
    trackingUri,
  };
  const adapter = adapterFor(tracker);
  if (!adapter) {
    return NextResponse.json({
      success: false,
      error: `No adapter for backend '${backend}'.`,
    });
  }
  const result = await adapter.testConnection(tracker);
  return NextResponse.json({
    success: result.ok,
    message: result.ok ? result.detail : undefined,
    error: result.ok ? undefined : result.detail,
  });
}
