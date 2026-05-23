/**
 * Deploy / tear down the Prometheus + Grafana (+ optional Loki) stack on
 * the cluster's stack host. POST deploys, DELETE tears down. Both wait
 * for the underlying BackgroundTask to finish and return the full log
 * inline.
 *
 *   # deploy
 *   curl -X POST -H "Authorization: Bearer aura_…" \
 *     http://localhost:3000/api/v1/clusters/<cluster>/metrics/stack
 *
 *   # teardown
 *   curl -X DELETE -H "Authorization: Bearer aura_…" \
 *     http://localhost:3000/api/v1/clusters/<cluster>/metrics/stack
 *
 * The stack host is read from cluster.config.metrics (stackHost field) —
 * defaults to the controller. Prometheus listens on metrics.prometheusPort
 * (default 9090), Grafana on metrics.grafanaPort (default 3000), and
 * Loki — when metrics.lokiEnabled — on metrics.lokiPort (default 3100).
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { forwardAndPoll, v1Url } from "@/lib/v1-task-poll";

interface RouteParams { params: Promise<{ cluster: string }> }

async function require_admin(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.role !== "ADMIN") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user };
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { cluster: id } = await params;
  const auth = await require_admin(req);
  if ("error" in auth) return auth.error;

  const r = await forwardAndPoll({
    innerUrl: v1Url(req, `/api/clusters/${id}/metrics/grafana/deploy`),
    method: "POST",
    authHeader: req.headers.get("authorization") ?? "",
    // Stack deploys download multi-100 MB tarballs (Grafana, Prometheus,
    // Loki) so allow up to 30 min — same ceiling as metrics/install.
    timeoutMs: 30 * 60 * 1000,
  });
  if (r.kind === "task") {
    return NextResponse.json({ ...r, clusterId: id }, { status: r.status === "success" ? 200 : 500 });
  }
  return NextResponse.json((r.payload as object) ?? { error: "Failed" }, { status: r.status });
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { cluster: id } = await params;
  const auth = await require_admin(req);
  if ("error" in auth) return auth.error;

  const r = await forwardAndPoll({
    innerUrl: v1Url(req, `/api/clusters/${id}/metrics/grafana/teardown`),
    method: "POST",
    authHeader: req.headers.get("authorization") ?? "",
    timeoutMs: 10 * 60 * 1000,
  });
  if (r.kind === "task") {
    return NextResponse.json({ ...r, clusterId: id }, { status: r.status === "success" ? 200 : 500 });
  }
  return NextResponse.json((r.payload as object) ?? { error: "Failed" }, { status: r.status });
}
