import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { subscribeHeartbeat } from "@/lib/nats";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/clusters/[id]/heartbeat/stream — SSE that fires once when agent connects
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };

      // Keep-alive ping every 20s so nginx doesn't close the connection
      const ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          clearInterval(ping);
        }
      }, 20_000);

      // Timeout after 90 minutes
      const timeout = setTimeout(() => {
        clearInterval(ping);
        send({ type: "timeout" });
        try { controller.close(); } catch {}
      }, 90 * 60 * 1000);

      try {
        const sub = await subscribeHeartbeat(id);
        for await (const _msg of sub) {
          clearTimeout(timeout);
          clearInterval(ping);

          // Mark token used
          await prisma.cluster.update({
            where: { id },
            data: { installTokenUsedAt: new Date() },
          });

          send({ type: "connected" });
          try { controller.close(); } catch {}
          sub.unsubscribe();
          return;
        }
      } catch (err) {
        clearTimeout(timeout);
        clearInterval(ping);
        send({ type: "error", message: err instanceof Error ? err.message : "NATS error" });
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
