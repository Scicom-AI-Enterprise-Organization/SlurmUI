import { WebSocket } from "ws";
import { readCommandStream } from "./nats";
import { prisma } from "./prisma";

interface WebSocketClient {
  ws: WebSocket;
  abortControllers: Map<string, AbortController>;
}

const clients = new Map<string, WebSocketClient>();

/**
 * Handle a new WebSocket connection.
 * Protocol:
 *   Client -> Server: { type: "subscribe", request_id: "uuid" }
 *   Server -> Client: { type: "stream", request_id: "uuid", line: "...", seq: N }
 *   Server -> Client: { type: "complete", request_id: "uuid", result: {...} }
 */
export async function handleWebSocket(
  ws: WebSocket,
  clusterId: string,
  userId: string
): Promise<void> {
  const clientId = `${userId}-${Date.now()}`;
  const client: WebSocketClient = {
    ws,
    abortControllers: new Map(),
  };
  clients.set(clientId, client);

  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === "subscribe" && message.request_id) {
        await subscribeToStream(client, clusterId, message.request_id);
      }

      if (message.type === "unsubscribe" && message.request_id) {
        const ac = client.abortControllers.get(message.request_id);
        if (ac) {
          ac.abort();
          client.abortControllers.delete(message.request_id);
        }
      }
    } catch (err) {
      console.error("[WS] Error processing message:", err);
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
    }
  });

  ws.on("close", () => {
    for (const ac of client.abortControllers.values()) {
      ac.abort();
    }
    clients.delete(clientId);
  });

  ws.on("error", (err) => {
    console.error("[WS] WebSocket error:", err);
  });
}

async function subscribeToStream(
  client: WebSocketClient,
  clusterId: string,
  requestId: string
): Promise<void> {
  const ac = new AbortController();
  client.abortControllers.set(requestId, ac);

  // readCommandStream replays buffered events first, then continues live.
  // This prevents race conditions where the agent streamed output before
  // the browser WS connection was established.
  (async () => {
    try {
      for await (const event of readCommandStream(requestId)) {
        if (ac.signal.aborted || client.ws.readyState !== WebSocket.OPEN) break;

        if (event.type === "stream") {
          const data = event.data as { line: string; seq: number };
          client.ws.send(JSON.stringify({
            type: "stream",
            request_id: requestId,
            line: data.line,
            seq: data.seq,
          }));
        } else if (event.type === "reply") {
          const reply = event.data as { type: string; payload: any };
          const success = reply.type === "result";
          const exitCode: number = success ? (reply.payload?.exit_code ?? 0) : -1;

          // Persist final status to DB so the page shows correct state on refresh.
          await prisma.job.update({
            where: { id: requestId },
            data: {
              status: success && exitCode === 0 ? "COMPLETED" : "FAILED",
              exitCode,
            },
          }).catch((err: unknown) => console.error("[WS] Failed to update job status:", err));

          client.ws.send(JSON.stringify({
            type: "complete",
            request_id: requestId,
            result: reply.payload,
          }));
          break;
        }
      }
    } catch (err) {
      console.error("[WS] Error in stream loop:", err);
    } finally {
      client.abortControllers.delete(requestId);
    }
  })();
}
