import { NextRequest } from "next/server";
import { attachShellSession, getShellSession } from "@/lib/cluster-shell";
import { getApiUser } from "@/lib/api-auth";

interface RouteParams { params: Promise<{ sessionId: string }> }

// GET /api/cluster-shell/[sessionId]/stream — SSE pipe carrying base64-
// encoded PTY output. Spawns the PTY on first connect, tears it down when
// the response stream closes.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { sessionId } = await params;

  const user = await getApiUser(req);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Defence in depth: the session was minted by the admin who owns the
  // browser tab. Don't let another logged-in user attach to it.
  const session = getShellSession(sessionId);
  if (!session) {
    return new Response("Session not found or expired", { status: 404 });
  }
  if (session.userId !== user.id && user.role !== "ADMIN") {
    return new Response("Forbidden", { status: 403 });
  }

  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let teardown: () => void = () => {};
      let closed = false;

      const send = (obj: object) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };

      teardown = await attachShellSession(sessionId, {
        onOutput: (buf) => send({ type: "data", data: buf.toString("base64") }),
        onExit: (exitCode) => {
          send({ type: "exit", code: exitCode });
          closed = true;
          try { controller.close(); } catch {}
        },
        onError: (msg) => {
          send({ type: "error", message: msg });
          closed = true;
          try { controller.close(); } catch {}
        },
      });

      // 15s keep-alive so the SSE connection survives idle periods through
      // any intermediate proxy that times out silent streams.
      const keepalive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch { closed = true; }
      }, 15_000);

      req.signal.addEventListener("abort", () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        try { teardown(); } catch {}
        try { controller.close(); } catch {}
      });
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
