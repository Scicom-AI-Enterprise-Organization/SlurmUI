import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { getShellSession, resizeShell, writeShellInput } from "@/lib/cluster-shell";

interface RouteParams { params: Promise<{ sessionId: string }> }

// POST /api/cluster-shell/[sessionId]/input — keystrokes (base64) or resize.
// Body shape: { type: "input", data: <base64> } | { type: "resize", cols, rows }.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { sessionId } = await params;

  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const session = getShellSession(sessionId);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (session.userId !== user.id && user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    type?: string;
    data?: string;
    cols?: number;
    rows?: number;
  };

  if (body.type === "input" && typeof body.data === "string") {
    const ok = writeShellInput(sessionId, Buffer.from(body.data, "base64"));
    return NextResponse.json({ ok });
  }
  if (
    body.type === "resize" &&
    typeof body.cols === "number" &&
    typeof body.rows === "number"
  ) {
    const ok = resizeShell(sessionId, body.cols, body.rows);
    return NextResponse.json({ ok });
  }
  return NextResponse.json({ error: "Bad request" }, { status: 400 });
}
