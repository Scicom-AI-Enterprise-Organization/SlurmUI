/**
 * Synchronous "tear down a self-hosted NFS export" endpoint.
 *
 *   curl -X DELETE -H "Authorization: Bearer aura_…" \
 *     http://localhost:3000/api/v1/clusters/<cluster>/storage/nfs-servers/<serverId>
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { forwardAndPoll, v1Url } from "@/lib/v1-task-poll";

interface RouteParams { params: Promise<{ cluster: string; serverId: string }> }

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { cluster: id, serverId } = await params;
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  const cfg = (cluster.config ?? {}) as Record<string, unknown>;
  const servers = (cfg.nfs_servers ?? []) as Array<{ id: string }>;
  const server = servers.find((s) => s.id === serverId);
  if (!server) return NextResponse.json({ error: "NFS server not found" }, { status: 404 });

  const r = await forwardAndPoll({
    innerUrl: v1Url(req, `/api/clusters/${id}/storage/nfs-server`),
    method: "POST",
    authHeader: req.headers.get("authorization") ?? "",
    body: { server, action: "remove" },
  });
  if (r.kind === "task") {
    return NextResponse.json({ ...r, clusterId: id }, { status: r.status === "success" ? 200 : 500 });
  }
  return NextResponse.json((r.payload as object) ?? { error: "Failed" }, { status: r.status });
}
