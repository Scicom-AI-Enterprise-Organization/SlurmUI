import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getNatsConnection, jc, subscribeCommandStream } from "@/lib/nats";

interface RouteParams {
  params: Promise<{ id: string; requestId: string }>;
}

// GET /api/clusters/[id]/stream/[requestId] — SSE bridge from NATS to browser
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id, requestId } = await params;
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // client disconnected
        }
      };

      let done = false;

      const { streamSub, replySub } = await subscribeCommandStream(id, requestId);

      // Timeout — close after 10 minutes if no reply
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          send({ type: "complete", success: false, message: "Command timed out after 10 minutes" });
          streamSub.unsubscribe();
          replySub.unsubscribe();
          try { controller.close(); } catch {}
        }
      }, 600_000);

      // Stream stdout lines
      (async () => {
        try {
          for await (const msg of streamSub) {
            if (done) break;
            const data = jc.decode(msg.data) as any;
            send({ type: "stream", line: data.line, seq: data.seq });
          }
        } catch {}
      })();

      // Wait for final reply
      (async () => {
        try {
          for await (const msg of replySub) {
            clearTimeout(timer);
            done = true;
            const data = jc.decode(msg.data) as any;
            send({
              type: "complete",
              success: data.type === "result",
              payload: data.payload,
            });
            streamSub.unsubscribe();
            try { controller.close(); } catch {}
            return;
          }
        } catch {}
      })();
    },

    cancel() {
      // Client disconnected — subscriptions will be GC'd
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
