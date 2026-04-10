import { prisma } from "@/lib/prisma";
import { getNatsConnection, jsonCodec } from "@/lib/nats";
import type { Subscription } from "nats";

const HEARTBEAT_TIMEOUT_MS = 30_000; // 30 seconds without heartbeat = DEGRADED
const OFFLINE_TIMEOUT_MS = 90_000;   // 90 seconds = OFFLINE
const CHECK_INTERVAL_MS = 15_000;    // Check status every 15 seconds

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

  // Initial subscription for all active/degraded clusters
  await refreshSubscriptions();

  // Periodically check for stale heartbeats and new clusters
  setInterval(async () => {
    await checkHeartbeats();
    await refreshSubscriptions();
  }, CHECK_INTERVAL_MS);
}

async function refreshSubscriptions(): Promise<void> {
  const clusters = await prisma.cluster.findMany({
    where: {
      status: { in: ["ACTIVE", "DEGRADED", "PROVISIONING"] },
    },
    select: { id: true },
  });

  const activeIds = new Set(clusters.map((c) => c.id));

  // Subscribe to new clusters
  for (const cluster of clusters) {
    if (!heartbeats.has(cluster.id)) {
      await subscribeToCluster(cluster.id);
    }
  }

  // Unsubscribe from removed clusters
  for (const [id, hb] of Array.from(heartbeats.entries())) {
    if (!activeIds.has(id)) {
      hb.subscription.unsubscribe();
      heartbeats.delete(id);
      console.log(`[Heartbeat] Unsubscribed from ${id}`);
    }
  }
}

async function subscribeToCluster(clusterId: string): Promise<void> {
  try {
    const nc = await getNatsConnection();
    const subject = `aura.cluster.${clusterId}.heartbeat`;
    const sub = nc.subscribe(subject);

    const hb: ClusterHeartbeat = {
      clusterId,
      lastSeen: 0, // Will be set on first heartbeat
      subscription: sub,
    };

    heartbeats.set(clusterId, hb);

    // Process heartbeats
    (async () => {
      for await (const msg of sub) {
        hb.lastSeen = Date.now();
        try {
          const data = jsonCodec.decode(msg.data) as Record<string, unknown>;
          // Heartbeat payload may include agent version, load, etc.
          console.log(`[Heartbeat] ${clusterId}: ${JSON.stringify(data)}`);
        } catch {
          // Ignore decode errors — timestamp is what matters
        }
      }
    })();

    console.log(`[Heartbeat] Subscribed to ${clusterId}`);
  } catch (err) {
    console.error(`[Heartbeat] Failed to subscribe to ${clusterId}:`, err);
  }
}

async function checkHeartbeats(): Promise<void> {
  const now = Date.now();

  for (const [clusterId, hb] of Array.from(heartbeats.entries())) {
    if (hb.lastSeen === 0) continue; // Never received a heartbeat yet

    const elapsed = now - hb.lastSeen;

    if (elapsed > OFFLINE_TIMEOUT_MS) {
      await updateClusterStatus(clusterId, "OFFLINE");
    } else if (elapsed > HEARTBEAT_TIMEOUT_MS) {
      await updateClusterStatus(clusterId, "DEGRADED");
    } else {
      await updateClusterStatus(clusterId, "ACTIVE");
    }
  }
}

async function updateClusterStatus(
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
