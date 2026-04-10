import { connect, NatsConnection, JSONCodec, Subscription } from "nats";

export const jc = JSONCodec();

let _conn: NatsConnection | null = null;

export async function getNatsConnection(): Promise<NatsConnection> {
  if (_conn && !_conn.isClosed()) return _conn;

  _conn = await connect({
    servers: process.env.NATS_URL ?? "nats://localhost:4222",
    name: "aura-web",
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
  });

  (async () => {
    for await (const s of _conn!.status()) {
      console.log(`[NATS] ${s.type}:`, s.data);
    }
  })();

  console.log("[NATS] Connected to", process.env.NATS_URL ?? "nats://localhost:4222");
  return _conn;
}

export interface AgentCommand {
  request_id: string;
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * Send a command to the cluster agent and wait for the reply.
 * Uses JetStream publish for guaranteed delivery + core NATS subscribe for reply.
 * Suitable for fast commands (submit_job, node_status, list_jobs, job_info, cancel_job).
 */
export async function sendCommandAndWait(
  clusterId: string,
  cmd: AgentCommand,
  timeoutMs = 30_000
): Promise<unknown> {
  const nc = await getNatsConnection();
  const js = nc.jetstream();

  const replySubject = `aura.cluster.${clusterId}.reply.${cmd.request_id}`;
  const commandSubject = `aura.cluster.${clusterId}.command`;

  // Subscribe BEFORE publishing to prevent race condition.
  const sub = nc.subscribe(replySubject, { max: 1 });

  try {
    await js.publish(commandSubject, jc.encode(cmd));
  } catch (err) {
    sub.unsubscribe();
    throw new Error(`Failed to publish command to cluster ${clusterId}: ${err instanceof Error ? err.message : err}`);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    (async () => {
      try {
        for await (const msg of sub) {
          clearTimeout(timer);
          resolve(jc.decode(msg.data));
          return;
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    })();
  });
}

/**
 * Publish a command to the cluster agent without waiting for a reply.
 * Returns the request_id so the caller can subscribe to the stream endpoint.
 * Suitable for long-running commands (activate_node, add_node, etc.).
 */
export async function publishCommand(
  clusterId: string,
  cmd: AgentCommand
): Promise<void> {
  const nc = await getNatsConnection();
  const js = nc.jetstream();
  const commandSubject = `aura.cluster.${clusterId}.command`;

  try {
    await js.publish(commandSubject, jc.encode(cmd));
  } catch (err) {
    throw new Error(`Failed to publish command to cluster ${clusterId}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Subscribe to heartbeats for a cluster.
 */
export async function subscribeHeartbeat(clusterId: string): Promise<Subscription> {
  const nc = await getNatsConnection();
  return nc.subscribe(`aura.cluster.${clusterId}.heartbeat`);
}

/**
 * Subscribe to a stream + reply subject pair for a specific request.
 * Used by the SSE stream route to forward NATS messages to the browser.
 */
export async function subscribeCommandStream(
  clusterId: string,
  requestId: string
): Promise<{ streamSub: Subscription; replySub: Subscription }> {
  const nc = await getNatsConnection();
  const streamSub = nc.subscribe(`aura.cluster.${clusterId}.stream.${requestId}`);
  const replySub = nc.subscribe(`aura.cluster.${clusterId}.reply.${requestId}`, { max: 1 });
  return { streamSub, replySub };
}
