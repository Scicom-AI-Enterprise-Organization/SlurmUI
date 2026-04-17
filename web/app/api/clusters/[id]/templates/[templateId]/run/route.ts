import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ id: string; templateId: string }> }

// POST — submit this template as a new job. Forwards to the existing
// /api/clusters/[id]/jobs POST handler so all the SSH / watcher logic is
// reused. Returns the created job record.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id, templateId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const t = await prisma.jobTemplate.findUnique({ where: { id: templateId } });
  if (!t || t.clusterId !== id || t.userId !== session.user.id) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  // Delegate to the jobs POST endpoint by re-calling it server-side through
  // a simple fetch on the same origin.
  const origin = new URL(req.url).origin;
  const res = await fetch(`${origin}/api/clusters/${id}/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: req.headers.get("cookie") ?? "",
    },
    body: JSON.stringify({ script: t.script, partition: t.partition }),
  });
  const body = await res.json().catch(() => ({}));
  return NextResponse.json(body, { status: res.status });
}
