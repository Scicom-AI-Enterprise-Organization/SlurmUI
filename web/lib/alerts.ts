/**
 * Webhook-based alert dispatcher.
 *
 * Admins define channels (Slack / Teams / generic) with an events filter;
 * every audit-log entry (and job lifecycle event) is matched against the
 * filters and fans out to matching webhooks.
 *
 * Storage: single Setting row keyed "alert_channels", value = JSON array.
 */

import { prisma } from "./prisma";

export type ChannelType = "slack" | "teams" | "generic";

export interface AlertChannel {
  id: string;
  name: string;
  type: ChannelType;
  url: string;
  events: string[]; // audit-action strings, supports trailing "*" wildcard
  /** Cluster ids this channel cares about. Empty list = all clusters. */
  clusters: string[];
  enabled: boolean;
  createdAt: string;
}

export async function loadChannels(): Promise<AlertChannel[]> {
  const row = await prisma.setting.findUnique({ where: { key: "alert_channels" } });
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveChannels(channels: AlertChannel[]): Promise<void> {
  await prisma.setting.upsert({
    where: { key: "alert_channels" },
    create: { key: "alert_channels", value: JSON.stringify(channels) },
    update: { value: JSON.stringify(channels) },
  });
}

function matches(action: string, filters: string[]): boolean {
  if (filters.length === 0) return true; // "no filter" = match everything
  for (const f of filters) {
    if (f === "*") return true;
    if (f.endsWith(".*")) {
      if (action.startsWith(f.slice(0, -1))) return true;
    } else if (f === action) {
      return true;
    }
  }
  return false;
}

function formatMessage(action: string, metadata?: Record<string, unknown>): string {
  const lines = [`*${action}*`];
  if (metadata && Object.keys(metadata).length > 0) {
    for (const [k, v] of Object.entries(metadata)) {
      if (v === null || v === undefined) continue;
      const val = typeof v === "object" ? JSON.stringify(v) : String(v);
      const short = val.length > 240 ? val.slice(0, 240) + "…" : val;
      lines.push(`• *${k}:* ${short}`);
    }
  }
  return lines.join("\n");
}

function buildPayload(channel: AlertChannel, text: string): unknown {
  // Slack incoming-webhook and Teams incoming-webhook both accept a bare
  // { "text": "..." } JSON body, so one format covers both. `generic` just
  // gets a structured blob.
  if (channel.type === "teams") {
    // Teams accepts MessageCard or a simple text payload. Use Markdown-ish text.
    return { text };
  }
  if (channel.type === "slack") {
    return { text };
  }
  return { text };
}

/**
 * Fire-and-forget dispatch. Never throws — webhook failures are logged and
 * swallowed so a bad channel config can't break the flow that triggered it.
 */
export async function dispatch(action: string, metadata?: Record<string, unknown>): Promise<void> {
  let channels: AlertChannel[];
  try {
    channels = await loadChannels();
  } catch {
    return;
  }
  // Pull the cluster id out of whatever shape the caller handed us. Audit
  // logs set `entityId` to the cluster id for cluster-level actions; job
  // events pass `clusterId` in metadata.
  const clusterId =
    (typeof metadata?.clusterId === "string" && metadata.clusterId) ||
    (typeof metadata?.entityId === "string" && metadata.entityId) ||
    "";

  const active = channels.filter((c) => {
    if (!c.enabled) return false;
    if (!matches(action, c.events ?? [])) return false;
    const scope = c.clusters ?? [];
    if (scope.length === 0) return true; // unscoped = all clusters
    return clusterId ? scope.includes(clusterId) : false;
  });
  if (active.length === 0) return;

  const text = formatMessage(action, metadata);
  await Promise.allSettled(active.map(async (c) => {
    try {
      const res = await fetch(c.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(c, text)),
      });
      if (!res.ok) {
        console.warn(`[alerts] channel "${c.name}" returned ${res.status}`);
      }
    } catch (err) {
      console.warn(`[alerts] channel "${c.name}" failed:`, err);
    }
  }));
}

/** Send a one-off test message (used by the "Test" button in the UI). */
export async function sendTest(channel: AlertChannel): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const res = await fetch(channel.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(channel, `:wave: Test alert from SlurmUI — channel *${channel.name}*`)),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 400) };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : "Unknown error" };
  }
}
