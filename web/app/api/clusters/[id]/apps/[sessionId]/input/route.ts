import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommandAndWait } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string; sessionId: string }> }

// POST /api/clusters/[id]/apps/[sessionId]/input — send keystrokes to terminal
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id, sessionId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const appSession = await prisma.appSession.findUnique({ where: { id: sessionId } });
  if (!appSession || appSession.clusterId !== id || appSession.userId !== session.user.id) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await req.json();
  // data: base64-encoded keystroke bytes
  const { data, cols, rows } = body;

  if (cols && rows) {
    // Resize request
    await sendCommandAndWait(id, {
      request_id: randomUUID(),
      type: "app_resize",
      payload: { session_id: sessionId, cols, rows },
    }, 3_000).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  if (!data) return NextResponse.json({ error: "data is required" }, { status: 400 });

  await sendCommandAndWait(id, {
    request_id: randomUUID(),
    type: "app_input",
    payload: { session_id: sessionId, data },
  }, 3_000);

  return NextResponse.json({ ok: true });
}
