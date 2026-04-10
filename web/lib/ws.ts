import { WebSocket } from "ws";
import { getNatsConnection, jsonCodec } from "@/lib/nats";
import type { Subscription } from "nats";

interface WebSocketClient {
  ws: WebSocket;
  subscriptions: Map<string, Subscription>;
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
    subscriptions: new Map(),
  };
  clients.set(clientId, client);

  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === "subscribe" && message.request_id) {
        await subscribeToStream(client, clusterId, message.request_id);
      }

      if (message.type === "unsubscribe" && message.request_id) {
        const sub = client.subscriptions.get(message.request_id);
        if (sub) {
          sub.unsubscribe();
          client.subscriptions.delete(message.request_id);
        }
      }
    } catch (err) {
      console.error("[WS] Error processing message:", err);
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
    }
  });

  ws.on("close", () => {
    // Clean up all subscriptions
    for (const sub of client.subscriptions.values()) {
      sub.unsubscribe();
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
  const nc = await getNatsConnection();

  // Subscribe to stream subject for live stdout lines
  const streamSubject = `aura.cluster.${clusterId}.stream.${requestId}`;
  const streamSub = nc.subscribe(streamSubject);
  client.subscriptions.set(`stream-${requestId}`, streamSub);

  (async () => {
    let seq = 0;
    for await (const msg of streamSub) {
      try {
        const line = jsonCodec.decode(msg.data) as string;
        seq++;
        client.ws.send(
          JSON.stringify({
            type: "stream",
            request_id: requestId,
            line,
            seq,
          })
        );
      } catch (err) {
        console.error("[WS] Error forwarding stream:", err);
      }
    }
  })();

  // Subscribe to reply subject for completion
  const replySubject = `aura.cluster.${clusterId}.reply.${requestId}`;
  const replySub = nc.subscribe(replySubject, { max: 1 });
  client.subscriptions.set(`reply-${requestId}`, replySub);

  (async () => {
    for await (const msg of replySub) {
      try {
        const result = jsonCodec.decode(msg.data);
        client.ws.send(
          JSON.stringify({
            type: "complete",
            request_id: requestId,
            result,
          })
        );
        // Clean up stream subscription after completion
        const streamSub = client.subscriptions.get(`stream-${requestId}`);
        if (streamSub) {
          streamSub.unsubscribe();
          client.subscriptions.delete(`stream-${requestId}`);
        }
        client.subscriptions.delete(`reply-${requestId}`);
      } catch (err) {
        console.error("[WS] Error forwarding reply:", err);
      }
    }
  })();
}
