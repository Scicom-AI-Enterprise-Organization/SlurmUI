import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readCommandStream } from "@/lib/nats";

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

      // Timeout — close after 10 minutes if no reply
      const timer = setTimeout(() => {
        send({ type: "complete", success: false, message: "Command timed out after 10 minutes" });
        try { controller.close(); } catch {}
      }, 600_000);

      try {
        for await (const event of readCommandStream(requestId)) {
          if (event.type === "stream") {
            const data = event.data as any;
            send({ type: "stream", line: data.line, seq: data.seq });
          } else {
            // reply — final event
            clearTimeout(timer);
            const data = event.data as any;
            send({
              type: "complete",
              success: data.type === "result",
              payload: data.payload,
            });
            try { controller.close(); } catch {}
            return;
          }
        }
      } catch {
        clearTimeout(timer);
        try { controller.close(); } catch {}
      }

      clearTimeout(timer);
    },

    cancel() {
      // Client disconnected
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
