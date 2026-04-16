import { prisma } from "./prisma";
import { sshExecSimple } from "./ssh-exec";
import type { Subscription } from "nats";

const HEARTBEAT_TIMEOUT_MS = 30_000; // 30 seconds without heartbeat = DEGRADED
const OFFLINE_TIMEOUT_MS = 90_000;   // 90 seconds = OFFLINE
const CHECK_INTERVAL_MS = 15_000;    // Check NATS heartbeats every 15 seconds
const SSH_CHECK_INTERVAL_MS = 60_000; // Check SSH clusters every 60 seconds

interface ClusterHeartbeat {
  clusterId: string;
  lastSeen: number;
  subscription: Subscription;
}

const heartbeats = new Map<string, ClusterHeartbeat>();

/**
 * Start the heartbeat monitor.
 * Call this once during server startup.
 */
export async function startHeartbeatMonitor(): Promise<void> {
  console.log("[Heartbeat] Starting monitor...");

  // NATS heartbeat subscriptions
  await refreshNatsSubscriptions();
  setInterval(async () => {
    await checkNatsHeartbeats();
    await refreshNatsSubscriptions();
  }, CHECK_INTERVAL_MS);

  // SSH cluster health checks
  setInterval(async () => {
    await checkSshClusters();
  }, SSH_CHECK_INTERVAL_MS);

  // Run first SSH check after a short delay
  setTimeout(() => checkSshClusters(), 10_000);
}

// ---- NATS heartbeats (for NATS-mode clusters) ----

async function refreshNatsSubscriptions(): Promise<void> {
  let getNatsConnection: any;
  try {
    const nats = await import("./nats");
    getNatsConnection = nats.getNatsConnection;
  } catch {
    return; // NATS not available
  }

  const clusters = await prisma.cluster.findMany({
    where: {
      connectionMode: "NATS",
      status: { in: ["ACTIVE", "DEGRADED", "PROVISIONING"] },
    },
    select: { id: true },
  });

  const activeIds = new Set(clusters.map((c) => c.id));

  for (const cluster of clusters) {
    if (!heartbeats.has(cluster.id)) {
      await subscribeToCluster(cluster.id, getNatsConnection);
    }
  }

  for (const [id, hb] of Array.from(heartbeats.entries())) {
    if (!activeIds.has(id)) {
      hb.subscription.unsubscribe();
      heartbeats.delete(id);
    }
  }
}

async function subscribeToCluster(clusterId: string, getNatsConnection: any): Promise<void> {
  try {
    const nc = await getNatsConnection();
    const { jc } = await import("./nats");
    const subject = `aura.cluster.${clusterId}.heartbeat`;
    const sub = nc.subscribe(subject);

    const hb: ClusterHeartbeat = {
      clusterId,
      lastSeen: 0,
      subscription: sub,
    };

    heartbeats.set(clusterId, hb);

    (async () => {
      for await (const msg of sub) {
        hb.lastSeen = Date.now();
        try {
          jc.decode(msg.data);
        } catch {}
      }
    })();

    console.log(`[Heartbeat] NATS subscribed: ${clusterId}`);
  } catch (err) {
    console.error(`[Heartbeat] NATS subscribe failed for ${clusterId}:`, err);
  }
}

async function checkNatsHeartbeats(): Promise<void> {
  const now = Date.now();

  for (const [clusterId, hb] of Array.from(heartbeats.entries())) {
    if (hb.lastSeen === 0) continue;

    const elapsed = now - hb.lastSeen;

    if (elapsed > OFFLINE_TIMEOUT_MS) {
      await updateStatus(clusterId, "OFFLINE");
    } else if (elapsed > HEARTBEAT_TIMEOUT_MS) {
      await updateStatus(clusterId, "DEGRADED");
    } else {
      await updateStatus(clusterId, "ACTIVE");
    }
  }
}

// ---- SSH health checks (for SSH-mode clusters) ----

async function checkSshClusters(): Promise<void> {
  const clusters = await prisma.cluster.findMany({
    where: {
      connectionMode: "SSH",
      status: { in: ["ACTIVE", "DEGRADED", "OFFLINE"] },
    },
    include: { sshKey: true },
  });

  for (const cluster of clusters) {
    if (!cluster.sshKey) continue;

    try {
      const result = await sshExecSimple(
        {
          host: cluster.controllerHost,
          user: cluster.sshUser,
          port: cluster.sshPort,
          privateKey: cluster.sshKey.privateKey,
        },
        // Quick health check: is the host reachable and is slurmctld running?
        "echo '__OK__' && (systemctl is-active slurmctld 2>/dev/null || echo 'slurm_down')"
      );

      if (result.success && result.stdout.includes("__OK__")) {
        if (result.stdout.includes("slurm_down")) {
          await updateStatus(cluster.id, "DEGRADED");
        } else {
          await updateStatus(cluster.id, "ACTIVE");
        }
      } else {
        await updateStatus(cluster.id, "OFFLINE");
      }
    } catch {
      await updateStatus(cluster.id, "OFFLINE");
    }
  }
}

// ---- Shared ----

async function updateStatus(
  clusterId: string,
  newStatus: "ACTIVE" | "DEGRADED" | "OFFLINE"
): Promise<void> {
  try {
    const cluster = await prisma.cluster.findUnique({
      where: { id: clusterId },
      select: { status: true },
    });

    if (cluster && cluster.status !== newStatus && cluster.status !== "PROVISIONING") {
      await prisma.cluster.update({
        where: { id: clusterId },
        data: { status: newStatus },
      });
      console.log(`[Heartbeat] ${clusterId}: ${cluster.status} -> ${newStatus}`);
    }
  } catch (err) {
    console.error(`[Heartbeat] Failed to update ${clusterId}:`, err);
  }
}
