/**
 * Synchronous "deploy a storage mount" endpoint.
 *
 *   curl -X POST -H "Authorization: Bearer aura_…" -H "Content-Type: application/json" \
 *     -d '{"mount":{"id":"<uuid>","type":"nfs","mountPath":"/mnt/shared","nfsServerId":"…"}}' \
 *     http://localhost:3000/api/v1/clusters/<cluster>/storage/mounts
 *
 * Body shape mirrors /api/clusters/[id]/storage/deploy:
 *   - `mount` (required): StorageMount object — pre-existing entry from
 *     cluster.config.storage_mounts.
 *
 * The deploy install only — to add a NEW mount entry, PATCH the cluster
 * config first via the regular /api/clusters/[id] route (it now accepts
 * Bearer too), then deploy with this endpoint.
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
    innerUrl: v1Url(req, `/api/clusters/${id}/storage/deploy`),
    method: "POST",
    authHeader: req.headers.get("authorization") ?? "",
    body,
  });
  if (r.kind === "task") {
    return NextResponse.json({ ...r, clusterId: id }, { status: r.status === "success" ? 200 : 500 });
  }
  return NextResponse.json((r.payload as object) ?? { error: "Failed" }, { status: r.status });
}
