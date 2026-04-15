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
          // Agent replies are {type, payload} — unwrap and reject on errors.
          const reply = jc.decode(msg.data) as { type: string; payload: unknown };
          if (reply.type === "error") {
            reject(new Error((reply.payload as any)?.error ?? "Agent returned error"));
          } else {
            resolve(reply.payload);
          }
          return;
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Stream buffer — fixes the race condition where the agent sends stream lines
// before the browser has opened the SSE connection.
//
// Flow:
//   1. POST handler calls publishCommand() which internally subscribes to the
//      NATS reply/stream subjects BEFORE publishing the command.
//   2. Any messages that arrive before the SSE route connects are buffered.
//   3. SSE route calls readCommandStream() which replays the buffer then
//      continues with live messages.
// ---------------------------------------------------------------------------

interface StreamBuffer {
  events: { type: "stream" | "reply"; data: any }[];
  waiters: Array<() => void>;
  done: boolean;
}

const streamBuffers = new Map<string, StreamBuffer>();

function pushEvent(buf: StreamBuffer, event: StreamBuffer["events"][0]) {
  buf.events.push(event);
  if (event.type === "reply") buf.done = true;
  const waiting = buf.waiters.splice(0);
  waiting.forEach((w) => w());
}

/**
 * Publish a command to the cluster agent without waiting for a reply.
 * Subscribes to the reply/stream NATS subjects BEFORE publishing so no
 * messages are missed regardless of how fast the agent responds.
 */
export async function publishCommand(
  clusterId: string,
  cmd: AgentCommand
): Promise<void> {
  const nc = await getNatsConnection();
  const js = nc.jetstream();
  const commandSubject = `aura.cluster.${clusterId}.command`;
  const streamSubject = `aura.cluster.${clusterId}.stream.${cmd.request_id}`;
  const replySubject = `aura.cluster.${clusterId}.reply.${cmd.request_id}`;

  const buf: StreamBuffer = { events: [], waiters: [], done: false };
  streamBuffers.set(cmd.request_id, buf);
  // Auto-cleanup after 15 minutes
  setTimeout(() => streamBuffers.delete(cmd.request_id), 900_000);

  // Subscribe BEFORE publishing — prevents race condition.
  const streamSub = nc.subscribe(streamSubject);
  const replySub = nc.subscribe(replySubject, { max: 1 });

  (async () => {
    try {
      for await (const msg of streamSub) {
        pushEvent(buf, { type: "stream", data: jc.decode(msg.data) });
      }
    } catch {}
  })();

  (async () => {
    try {
      for await (const msg of replySub) {
        pushEvent(buf, { type: "reply", data: jc.decode(msg.data) });
        streamSub.unsubscribe();
      }
    } catch {}
  })();

  try {
    await js.publish(commandSubject, jc.encode(cmd));
  } catch (err) {
    streamBuffers.delete(cmd.request_id);
    streamSub.unsubscribe();
    replySub.unsubscribe();
    throw new Error(`Failed to publish command to cluster ${clusterId}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Async generator that replays buffered stream events then yields live ones.
 * Used by the SSE route — works correctly even if called after the agent
 * has already finished processing.
 */
export async function* readCommandStream(
  requestId: string
): AsyncGenerator<StreamBuffer["events"][0]> {
  const buf = streamBuffers.get(requestId);
  if (!buf) {
    yield { type: "reply", data: { type: "error", payload: { error: "Stream not found — request may have expired" } } };
    return;
  }

  let index = 0;
  while (true) {
    if (index < buf.events.length) {
      const event = buf.events[index++];
      yield event;
      if (event.type === "reply") return;
    } else if (buf.done) {
      return;
    } else {
      await new Promise<void>((resolve) => buf.waiters.push(resolve));
    }
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
