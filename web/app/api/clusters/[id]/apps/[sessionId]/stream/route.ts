import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readCommandStream } from "@/lib/nats";

interface RouteParams { params: Promise<{ id: string; sessionId: string }> }

// GET /api/clusters/[id]/apps/[sessionId]/stream — SSE terminal output
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id, sessionId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const appSession = await prisma.appSession.findUnique({ where: { id: sessionId } });
  if (!appSession || appSession.clusterId !== id) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      try {
        for await (const event of readCommandStream(sessionId)) {
          if (event.type === "stream") {
            const data = event.data as any;
            const line: string = data.line ?? "";

            if (line.startsWith("__PTY__:")) {
              // Raw PTY bytes (base64-encoded) — forward to terminal
              send({ type: "pty", data: line.slice("__PTY__:".length) });
            } else {
              // Plain text log line (startup messages, errors)
              send({ type: "log", line });
            }
          } else {
            // Final reply — session ended or Jupyter started
            const payload = (event.data as any)?.payload ?? {};
            const eventType = payload.type as string | undefined;

            if (eventType === "jupyter_started") {
              // Update DB with access URL
              await prisma.appSession.update({
                where: { id: sessionId },
                data: { status: "RUNNING", accessUrl: payload.access_url },
              }).catch(() => {});
              send({ type: "jupyter_ready", access_url: payload.access_url, note: payload.note });
            } else {
              // Shell exited
              await prisma.appSession.update({
                where: { id: sessionId },
                data: { status: "STOPPED" },
              }).catch(() => {});
              send({ type: "exit", exit_code: payload.exit_code ?? 0 });
            }
            try { controller.close(); } catch {}
            return;
          }
        }
      } catch {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
