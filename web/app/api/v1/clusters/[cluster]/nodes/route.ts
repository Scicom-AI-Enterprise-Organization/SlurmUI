/**
 * Add a node to a cluster — Bearer-auth, synchronous.
 *
 * Thin wrapper around the existing /api/clusters/[id]/nodes/add endpoint
 * — same body shape, blocks until the SSH setup finishes, returns full
 * stdout + the resulting BackgroundTask record.
 *
 *   curl -X POST -H "Authorization: Bearer aura_…" \
 *     -H "Content-Type: application/json" \
 *     -d '{"nodeName":"gpu1","ip":"localhost","sshUser":"root","cpus":8,"gpus":0,"memoryMb":16384}' \
 *     http://localhost:3000/api/v1/clusters/<id>/nodes
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ cluster: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { cluster: id } = await params;

  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));

  // Forward to the existing background-task endpoint, then poll its
  // BackgroundTask row until it leaves the "running" state. Reusing the
  // existing endpoint avoids duplicating the (long) install script — but
  // we need to authenticate the internal call, so we forward our own
  // Bearer header back to itself; the underlying route uses the
  // session-cookie path, so we set a header that getApiUser also reads.
  const internal = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/clusters/${id}/nodes/add`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Forward the Bearer token so the inner handler sees the same admin
      // via getApiUser. Note: the existing route uses `auth()` and would
      // 401 a Bearer-only request — so we pass through the existing path
      // by populating the request via the same token. The inner route
      // also accepts API tokens via middleware.ts's /api/v1 carve-out
      // when called directly, but here we want the underlying SSH work.
      Authorization: req.headers.get("authorization") ?? "",
    },
    body: JSON.stringify(body),
  });

  if (!internal.ok) {
    const err = await internal.json().catch(() => ({}));
    return NextResponse.json({
      status: "failed",
      error: err.error ?? `Inner add-node failed (HTTP ${internal.status})`,
    }, { status: internal.status });
  }
  const { taskId } = await internal.json() as { taskId: string };

  // Poll the BackgroundTask until it leaves "running". 10s poll, 30 min
  // hard cap (install script can take a while on a fresh node).
  const deadlineMs = Date.now() + 30 * 60 * 1000;
  let task = await prisma.backgroundTask.findUnique({ where: { id: taskId } });
  while (task && task.status === "running" && Date.now() < deadlineMs) {
    await new Promise((r) => setTimeout(r, 2000));
    task = await prisma.backgroundTask.findUnique({ where: { id: taskId } });
  }
  if (!task) return NextResponse.json({ status: "failed", error: "Task disappeared" }, { status: 500 });

  return NextResponse.json({
    status: task.status === "success" ? "success" : "failed",
    taskId,
    logs: task.logs ?? "",
    nodeName: body.nodeName,
    clusterId: id,
  }, { status: task.status === "success" ? 200 : 500 });
}
