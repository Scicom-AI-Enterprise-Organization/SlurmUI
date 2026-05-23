/**
 * Install apt packages on every cluster node.
 *
 *   curl -X POST -H "Authorization: Bearer aura_…" -H "Content-Type: application/json" \
 *     -d '{"packages":["htop","jq","curl"]}' \
 *     http://localhost:3000/api/v1/clusters/<cluster>/packages
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
    innerUrl: v1Url(req, `/api/clusters/${id}/packages`),
    method: "POST",
    authHeader: req.headers.get("authorization") ?? "",
    body,
  });
  if ("status" in r && (r.status === "success" || r.status === "failed")) {
    return NextResponse.json({ ...r, clusterId: id }, { status: r.status === "success" ? 200 : 500 });
  }
  return NextResponse.json(r.payload ?? { error: "Failed" }, { status: r.status });
}
