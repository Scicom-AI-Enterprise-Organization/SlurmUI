/**
 * Install the metrics stack (node_exporter / nvidia_gpu_exporter / promtail)
 * across the cluster and register prometheus scrape targets.
 *
 *   curl -X POST -H "Authorization: Bearer aura_…" -H "Content-Type: application/json" \
 *     -d '{}'  http://localhost:3000/api/v1/clusters/<cluster>/metrics/install
 *
 * Body is optional — body.hostnames lets you scope the install to a subset
 * of nodes, body.mode picks the GPU exporter mode. The inner endpoint
 * returns `{taskId}` and runs the install in background, so this wrapper
 * polls until completion and returns the final log inline.
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { forwardAndPoll, v1Url } from "@/lib/v1-task-poll";

interface RouteParams { params: Promise<{ cluster: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { cluster: id } = await params;
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const r = await forwardAndPoll({
    innerUrl: v1Url(req, `/api/clusters/${id}/metrics/install`),
    method: "POST",
    authHeader: req.headers.get("authorization") ?? "",
    body,
    timeoutMs: 30 * 60 * 1000,
  });
  if (r.kind === "task") {
    return NextResponse.json({ ...r, clusterId: id }, { status: r.status === "success" ? 200 : 500 });
  }
  return NextResponse.json((r.payload as object) ?? { error: "Failed" }, { status: r.status });
}
