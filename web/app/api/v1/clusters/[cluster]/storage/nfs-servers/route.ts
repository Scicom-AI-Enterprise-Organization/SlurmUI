/**
 * Synchronous "provision a self-hosted NFS server" endpoint.
 *
 *   curl -X POST -H "Authorization: Bearer aura_…" -H "Content-Type: application/json" \
 *     -d '{"server":{"id":"nfs-1","hostNode":"gpu1","exportPath":"/srv/aura","allowedNetwork":"*"}}' \
 *     http://localhost:3000/api/v1/clusters/<cluster>/storage/nfs-servers
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
    innerUrl: v1Url(req, `/api/clusters/${id}/storage/nfs-server`),
    method: "POST",
    authHeader: req.headers.get("authorization") ?? "",
    body,
  });
  if (r.kind === "task") {
    return NextResponse.json({ ...r, clusterId: id }, { status: r.status === "success" ? 200 : 500 });
  }
  return NextResponse.json((r.payload as object) ?? { error: "Failed" }, { status: r.status });
}
