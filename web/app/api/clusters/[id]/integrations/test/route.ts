/**
 * Test Connection on an unsaved tracker (Add Tracker form's "Test" button).
 *
 * We deliberately don't persist anything here — the form takes the result
 * and decides whether to allow the actual create. Same shape as the
 * /storage/test endpoint.
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { adapterFor } from "@/lib/experiment-trackers";
import type { ExperimentTracker, TrackerBackend } from "@/lib/experiment-trackers/types";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, _ctx: RouteParams) {
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const backend = body.backend as TrackerBackend;
  const trackingUri = typeof body.trackingUri === "string" ? body.trackingUri.trim() : "";
  // Pass through optional basic-auth so the test reflects exactly what will
  // run in prod — if the server requires auth and the user typed creds, we
  // want the test to fail when those creds are wrong, not silently 200 from
  // some open endpoint.
  const username =
    typeof body.username === "string" && body.username.trim()
      ? body.username.trim()
      : undefined;
  const password =
    typeof body.password === "string" && body.password.length > 0
      ? body.password
      : undefined;

  // Synthetic tracker — the adapter doesn't need the persisted id/name
  // for testConnection.
  const tracker: ExperimentTracker = {
    id: "test",
    name: "test",
    backend,
    trackingUri,
    username,
    password,
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
