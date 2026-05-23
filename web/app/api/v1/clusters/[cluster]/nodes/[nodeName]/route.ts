/**
 * Delete a node from a cluster — Bearer-auth, synchronous.
 *
 *   curl -X DELETE -H "Authorization: Bearer aura_…" \
 *     http://localhost:3000/api/v1/clusters/<id>/nodes/<nodeName>
 *
 * Forwards to the existing DELETE /api/clusters/[id]/nodes/[nodeName] and
 * returns its output. The middleware already lets Bearer-auth requests
 * through (see middleware.ts) and the inner route accepts Bearer via
 * getApiUser.
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ cluster: string; nodeName: string }> }

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { cluster: id, nodeName } = await params;

  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const inner = await fetch(
    `http://127.0.0.1:${process.env.PORT ?? 3000}/api/clusters/${id}/nodes/${encodeURIComponent(nodeName)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: req.headers.get("authorization") ?? "",
      },
    },
  );

  const body = await inner.json().catch(() => ({}));
  return NextResponse.json(body, { status: inner.status });
}
