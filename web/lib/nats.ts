import { connect, NatsConnection, JSONCodec, StringCodec, Subscription } from "nats";

const jc = JSONCodec();
const sc = StringCodec();

let natsConnection: NatsConnection | null = null;

export async function getNatsConnection(): Promise<NatsConnection> {
  if (natsConnection && !natsConnection.isClosed()) {
    return natsConnection;
  }

  natsConnection = await connect({
    servers: process.env.NATS_URL ?? "nats://localhost:4222",
    name: "aura-web",
    reconnect: true,
    maxReconnectAttempts: -1, // infinite
    reconnectTimeWait: 2000,
  });

  // Monitor connection status
  (async () => {
    for await (const status of natsConnection!.status()) {
      console.log(`[NATS] ${status.type}: ${JSON.stringify(status.data)}`);
    }
  })();

  console.log("[NATS] Connected to", process.env.NATS_URL);
  return natsConnection;
}

/**
 * Send a command to a cluster agent and wait for a reply.
 * Uses request-reply pattern with timeout.
 */
export async function sendCommand(
  clusterId: string,
  command: Record<string, unknown>,
  timeoutMs: number = 30000
): Promise<unknown> {
  const nc = await getNatsConnection();
  const subject = `aura.cluster.${clusterId}.command`;

  const reply = await nc.request(subject, jc.encode(command), {
    timeout: timeoutMs,
  });

  return jc.decode(reply.data);
}

/**
 * Send a command to a cluster agent and return a subscription
 * for streaming replies. Used for long-running operations.
 */
export async function sendCommandWithStream(
  clusterId: string,
  command: Record<string, unknown> & { request_id: string }
): Promise<{ reply: Promise<unknown>; streamSub: Subscription }> {
  const nc = await getNatsConnection();
  const commandSubject = `aura.cluster.${clusterId}.command`;
  const streamSubject = `aura.cluster.${clusterId}.stream.${command.request_id}`;
  const replySubject = `aura.cluster.${clusterId}.reply.${command.request_id}`;

  // Subscribe to stream before sending command
  const streamSub = nc.subscribe(streamSubject);

  // Subscribe to reply (one-shot)
  const replyPromise = new Promise<unknown>((resolve, reject) => {
    const replySub = nc.subscribe(replySubject, { max: 1 });
    (async () => {
      for await (const msg of replySub) {
        resolve(jc.decode(msg.data));
      }
    })().catch(reject);

    // Timeout after 10 minutes for long operations
    setTimeout(() => {
      replySub.unsubscribe();
      reject(new Error("Command reply timeout"));
    }, 600000);
  });

  // Publish command
  nc.publish(commandSubject, jc.encode(command));

  return { reply: replyPromise, streamSub };
}

/**
 * Subscribe to heartbeats for a cluster.
 * Returns a subscription that yields heartbeat messages.
 */
export async function subscribeHeartbeat(clusterId: string): Promise<Subscription> {
  const nc = await getNatsConnection();
  return nc.subscribe(`aura.cluster.${clusterId}.heartbeat`);
}

/**
 * Publish a deploy job to a cluster agent.
 */
export async function publishDeploy(
  clusterId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const nc = await getNatsConnection();
  nc.publish(`aura.deploy.${clusterId}`, jc.encode(payload));
}

export { jc as jsonCodec, sc as stringCodec };
