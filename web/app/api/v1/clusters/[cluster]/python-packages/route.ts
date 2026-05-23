/**
 * Install Python packages into the cluster's venv.
 *
 *   curl -X POST -H "Authorization: Bearer aura_…" -H "Content-Type: application/json" \
 *     -d '{
 *           "packages": [{"name":"vllm==0.19.1"}],
 *           "installMode": "per-node",
 *           "localVenvPath": "/opt/aura-venv",
 *           "pythonVersion": "3.12"
 *         }' \
 *     http://localhost:3000/api/v1/clusters/<cluster>/python-packages
 *
 * Two-step internally: PUT /python-packages persists the package list +
 * mode into cluster.config, then POST /python-packages/apply runs the
 * actual install. We block until apply's BackgroundTask finishes and
 * return the combined log.
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

  // Step 1: persist packages + install mode via PUT.
  const putRes = await fetch(v1Url(req, `/api/clusters/${id}/python-packages`), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: req.headers.get("authorization") ?? "",
    },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    return NextResponse.json({ status: "failed", stage: "save-config", error: err.error ?? `HTTP ${putRes.status}` }, { status: putRes.status });
  }

  // Step 2: run the apply, poll the resulting BackgroundTask.
  const r = await forwardAndPoll({
    innerUrl: v1Url(req, `/api/clusters/${id}/python-packages/apply`),
    method: "POST",
    authHeader: req.headers.get("authorization") ?? "",
    timeoutMs: 60 * 60 * 1000, // 1 hour — vllm/torch installs can take a while
  });
  if (r.kind === "task") {
    return NextResponse.json({ ...r, clusterId: id }, { status: r.status === "success" ? 200 : 500 });
  }
  return NextResponse.json((r.payload as object) ?? { error: "Failed" }, { status: r.status });
}
