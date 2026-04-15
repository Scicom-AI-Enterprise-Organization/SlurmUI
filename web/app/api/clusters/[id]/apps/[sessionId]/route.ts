import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommandAndWait } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string; sessionId: string }> }

// GET /api/clusters/[id]/apps/[sessionId]
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id, sessionId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const appSession = await prisma.appSession.findUnique({ where: { id: sessionId } });
  if (!appSession || appSession.clusterId !== id) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (appSession.userId !== session.user.id && (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(appSession);
}

// PATCH /api/clusters/[id]/apps/[sessionId] — update status (called by SSE stream on exit)
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, sessionId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { status, access_url } = await req.json();
  const appSession = await prisma.appSession.update({
    where: { id: sessionId },
    data: {
      ...(status ? { status } : {}),
      ...(access_url ? { accessUrl: access_url } : {}),
    },
  });

  return NextResponse.json(appSession);
}

// DELETE /api/clusters/[id]/apps/[sessionId] — kill app session
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id, sessionId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const appSession = await prisma.appSession.findUnique({ where: { id: sessionId } });
  if (!appSession || appSession.clusterId !== id) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  await prisma.appSession.update({ where: { id: sessionId }, data: { status: "STOPPED" } });

  await sendCommandAndWait(id, {
    request_id: randomUUID(),
    type: "kill_app",
    payload: { session_id: sessionId },
  }, 5_000).catch(() => {});

  return NextResponse.json({ ok: true });
}
