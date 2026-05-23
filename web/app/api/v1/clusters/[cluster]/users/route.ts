/**
 * Provision a user to the cluster (creates Linux account + munge key
 * sync via the underlying /api/clusters/[id]/users route).
 *
 *   curl -X POST -H "Authorization: Bearer aura_…" -H "Content-Type: application/json" \
 *     -d '{"userId":"<aura-user-uuid>"}' \
 *     http://localhost:3000/api/v1/clusters/<cluster>/users
 *
 * The underlying endpoint runs synchronously already (no BackgroundTask),
 * so this is a thin pass-through.
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { v1Url } from "@/lib/v1-task-poll";

interface RouteParams { params: Promise<{ cluster: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { cluster: id } = await params;
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.text();
  const inner = await fetch(v1Url(req, `/api/clusters/${id}/users`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: req.headers.get("authorization") ?? "",
    },
    body,
  });
  const payload = await inner.json().catch(() => ({}));
  return NextResponse.json(payload, { status: inner.status });
}
