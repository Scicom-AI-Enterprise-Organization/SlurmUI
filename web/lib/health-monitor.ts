/**
 * Periodic health poller.
 *
 * Every `SLURMUI_HEALTH_INTERVAL_SEC` seconds (default 60) we SSH into each
 * ACTIVE cluster and collect:
 *   - scontrol ping        → slurmctld reachable?
 *   - sinfo -h -N          → per-node state + reason
 *   - squeue -h            → jobid → state (to catch terminal transitions
 *                            we'd otherwise miss when no watcher is running)
 *   - mountpoint -q        → each configured storage mount on each worker
 *
 * Results are compared against the previous tick. State transitions fire
 * audit-log entries (which fan out to alert channels). Snapshots are kept
 * in-memory and exposed via `getLatestHealth()` for the UI.
 */

import { prisma } from "./prisma";
import { sshExecScript } from "./ssh-exec";
import { logAudit } from "./audit";

interface HostEntry { hostname: string; ip: string; user?: string; port?: number }
interface StorageMount { id: string; mountPath: string; type: string }

export interface NodeHealth {
  name: string;
  state: string;     // e.g. "idle", "drain", "down", "mix"
  reason?: string;   // sinfo %E column, when something is wrong
}

export interface StorageHealth {
  mountId: string;
  mountPath: string;
  hostname: string;
  mounted: boolean;
}

export interface QueueReasonCount { reason: string; count: number }
export interface StuckJob { slurmJobId: string; user: string; reason: string; pendingSeconds: number; held: boolean }

export interface ClusterHealth {
  clusterId: string;
  clusterName: string;
  checkedAt: string;
  slurmctldUp: boolean;
  slurmctldMessage?: string;
  nodes: NodeHealth[];
  storage: StorageHealth[];
  jobsTracked: number;   // how many running/pending jobs the poll saw
  pendingCount: number;
  runningCount: number;
  heldCount: number;
  oldestPendingSeconds: number;
  pendingByReason: QueueReasonCount[];
  stuckJobs: StuckJob[];
  errors: string[];
}

const cache = new Map<string, ClusterHealth>();

export function getLatestHealth(clusterId: string): ClusterHealth | null {
  return cache.get(clusterId) ?? null;
}

export function getAllHealth(): ClusterHealth[] {
  return Array.from(cache.values());
}

function buildScript(config: Record<string, unknown>): string {
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const controllerHost = (config.slurm_controller_host ?? "") as string;
  const workers = hostsEntries.filter((h) => h.hostname !== controllerHost);
  const targets = workers.length > 0 ? workers : hostsEntries;
  const mounts = (config.storage_mounts ?? []) as StorageMount[];

  const mountBlock = mounts.length === 0 ? "" : targets.map((w) => {
    const u = w.user || "root";
    const p = w.port || 22;
    const checks = mounts.map((m) =>
      `mountpoint -q "${m.mountPath}" && echo "STORAGE|${w.hostname}|${m.id}|mounted" || echo "STORAGE|${w.hostname}|${m.id}|unmounted"`
    ).join("; ");
    return `timeout 8 ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 -p ${p} ${u}@${w.ip} '${checks}' 2>/dev/null || echo "STORAGE|${w.hostname}|__NA__|unreachable"`;
  }).join("\n");

  return `#!/bin/bash
set +e

echo "__SCTL_PING_START__"
scontrol ping 2>&1 | head -3
echo "__SCTL_PING_END__"

echo "__NODES_START__"
# hostname|state|reason (reason may contain spaces, quoted in %E)
sinfo -h -N -o "%n|%t|%E" 2>/dev/null
echo "__NODES_END__"

echo "__JOBS_START__"
squeue -h -o "%i|%T|%r|%u|%V" 2>/dev/null | head -2000
echo "__JOBS_END__"

echo "__STORAGE_START__"
${mountBlock || "echo ''"}
echo "__STORAGE_END__"
`;
}

function extractSection(full: string, start: string, end: string): string {
  const s = full.indexOf(start);
  const e = full.indexOf(end);
  if (s === -1 || e === -1) return "";
  return full.slice(s + start.length, e).trim();
}

async function pollCluster(clusterId: string): Promise<void> {
  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey) return;
  if (cluster.status !== "ACTIVE" && cluster.status !== "DEGRADED") return;

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const config = cluster.config as Record<string, unknown>;
  const mounts = (config.storage_mounts ?? []) as StorageMount[];

  const script = buildScript(config);
  const chunks: string[] = [];
  const timeoutMs = 45_000;
  const deadline = Date.now() + timeoutMs;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), timeoutMs);
    sshExecScript(target, script, {
      onStream: (line) => { if (!line.startsWith("[stderr]") && Date.now() < deadline) chunks.push(line); },
      onComplete: () => { clearTimeout(t); resolve(); },
    });
  });

  const full = chunks.join("\n");
  const errors: string[] = [];

  // Parse
  const pingBody = extractSection(full, "__SCTL_PING_START__", "__SCTL_PING_END__");
  const slurmctldUp = /is UP/i.test(pingBody) || /\bUP\b/.test(pingBody);
  const nodesBody = extractSection(full, "__NODES_START__", "__NODES_END__");
  const jobsBody = extractSection(full, "__JOBS_START__", "__JOBS_END__");
  const storageBody = extractSection(full, "__STORAGE_START__", "__STORAGE_END__");

  if (!slurmctldUp && pingBody) errors.push(`scontrol ping: ${pingBody.slice(0, 120)}`);

  const nodes: NodeHealth[] = nodesBody.split("\n").filter(Boolean).map((line) => {
    const [name, state, reason] = line.split("|");
    return { name: (name ?? "").trim(), state: (state ?? "").trim().toLowerCase(), reason: (reason ?? "").trim() || undefined };
  }).filter((n) => n.name);

  const storage: StorageHealth[] = storageBody.split("\n").filter((l) => l.startsWith("STORAGE|")).map((line) => {
    const [, hostname, mountId, status] = line.split("|");
    const m = mounts.find((x) => x.id === mountId);
    return {
      mountId,
      mountPath: m?.mountPath ?? mountId,
      hostname,
      mounted: status === "mounted",
    };
  });

  const jobStateById = new Map<string, string>();
  const pendingByReason = new Map<string, number>();
  const stuckJobs: StuckJob[] = [];
  const STUCK_THRESHOLD_SEC = parseInt(process.env.SLURMUI_STUCK_JOB_THRESHOLD_SEC ?? "600", 10);
  const NON_PROGRESS_REASONS = new Set([
    "Dependency", "DependencyNeverSatisfied", "JobHeldUser", "JobHeldAdmin",
    "BadConstraints", "InvalidAccount", "InvalidQOS", "AssocGrpCPURunMinutesLimit",
    "AssocMaxCpuPerJobLimit", "QOSMaxJobsPerUserLimit", "QOSMaxSubmitJobPerUserLimit",
    "ReqNodeNotAvail",
  ]);
  let pendingCount = 0, runningCount = 0, heldCount = 0;
  let oldestPendingSeconds = 0;
  const nowMs = Date.now();
  for (const line of jobsBody.split("\n")) {
    const [id, state, reason, user, submit] = line.split("|");
    if (!id || !state) continue;
    const sid = id.trim();
    const st = state.trim().toUpperCase();
    const rsn = (reason ?? "").trim();
    jobStateById.set(sid, st);
    if (st === "RUNNING") runningCount++;
    if (st === "PENDING") {
      pendingCount++;
      pendingByReason.set(rsn || "Unknown", (pendingByReason.get(rsn || "Unknown") ?? 0) + 1);
      const submitMs = submit ? new Date(submit.trim()).getTime() : NaN;
      const pendingSeconds = Number.isFinite(submitMs) ? Math.floor((nowMs - submitMs) / 1000) : 0;
      if (pendingSeconds > oldestPendingSeconds) oldestPendingSeconds = pendingSeconds;
      const isHeld = rsn === "JobHeldUser" || rsn === "JobHeldAdmin";
      if (isHeld) heldCount++;
      const stuckByReason = NON_PROGRESS_REASONS.has(rsn) && pendingSeconds > STUCK_THRESHOLD_SEC;
      const stuckByTime = pendingSeconds > STUCK_THRESHOLD_SEC * 6 && (rsn === "Priority" || rsn === "Resources");
      if (stuckByReason || stuckByTime || isHeld) {
        stuckJobs.push({ slurmJobId: sid, user: (user ?? "").trim(), reason: rsn, pendingSeconds, held: isHeld });
      }
    }
  }

  // ── Diff against previous snapshot and fire alerts ──
  const prev = cache.get(clusterId);
  const meta = { clusterId, clusterName: cluster.name };

  if (prev) {
    // slurmctld health transitions
    if (prev.slurmctldUp && !slurmctldUp) {
      logAudit({ action: "cluster.unreachable", entity: "Cluster", entityId: clusterId, metadata: { ...meta, detail: pingBody.slice(0, 200) } });
    } else if (!prev.slurmctldUp && slurmctldUp) {
      logAudit({ action: "cluster.recovered", entity: "Cluster", entityId: clusterId, metadata: meta });
    }

    // Node state transitions — only care about ones entering/leaving unhealthy.
    const prevByName = new Map(prev.nodes.map((n) => [n.name, n]));
    const BAD = ["down", "drain", "fail", "err", "boot_fail", "not_responding"];
    const isBad = (s: string) => BAD.some((b) => s.includes(b));
    for (const n of nodes) {
      const p = prevByName.get(n.name);
      if (!p) continue;
      if (!isBad(p.state) && isBad(n.state)) {
        logAudit({
          action: "node.unhealthy",
          entity: "Node",
          entityId: clusterId,
          metadata: { ...meta, node: n.name, state: n.state, reason: n.reason },
        });
      } else if (isBad(p.state) && !isBad(n.state)) {
        logAudit({
          action: "node.recovered",
          entity: "Node",
          entityId: clusterId,
          metadata: { ...meta, node: n.name, state: n.state },
        });
      }
    }

    // Storage mount transitions — per (host, mount).
    const prevStorage = new Map(prev.storage.map((s) => [`${s.hostname}|${s.mountId}`, s]));
    for (const s of storage) {
      const key = `${s.hostname}|${s.mountId}`;
      const p = prevStorage.get(key);
      if (!p) continue;
      if (p.mounted && !s.mounted) {
        logAudit({
          action: "storage.disconnected",
          entity: "Cluster",
          entityId: clusterId,
          metadata: { ...meta, host: s.hostname, mountPath: s.mountPath, mountId: s.mountId },
        });
      } else if (!p.mounted && s.mounted) {
        logAudit({
          action: "storage.reconnected",
          entity: "Cluster",
          entityId: clusterId,
          metadata: { ...meta, host: s.hostname, mountPath: s.mountPath, mountId: s.mountId },
        });
      }
    }

    // Stuck / held job transitions — only alert when a job first becomes stuck.
    const prevStuck = new Set(prev.stuckJobs.map((j) => j.slurmJobId));
    for (const s of stuckJobs) {
      if (prevStuck.has(s.slurmJobId)) continue;
      logAudit({
        action: s.held ? "job.held" : "job.stuck",
        entity: "Job",
        entityId: clusterId,
        metadata: { ...meta, slurmJobId: s.slurmJobId, user: s.user, reason: s.reason, pendingSeconds: s.pendingSeconds },
      });
    }
  }

  // ── Reconcile job state with DB (catches transitions when no watcher is attached) ──
  // Two passes:
  //  (1) DB says PENDING/RUNNING + squeue says nothing → terminal.
  //  (2) DB says terminal but squeue still has the job RUNNING/PENDING → revive
  //      it. Catches false-COMPLETEs from the watcher's empty-squeue heuristic
  //      after web restarts / SSH blips.
  try {
    const inflight = await prisma.job.findMany({
      where: { clusterId, status: { in: ["PENDING", "RUNNING"] }, slurmJobId: { not: null } },
      select: { id: true, slurmJobId: true, status: true },
    });
    for (const j of inflight) {
      const sid = String(j.slurmJobId);
      const sState = jobStateById.get(sid);
      if (!sState) {
        // Disappeared from squeue → assume terminal. We can't tell success
        // without sacct; mark COMPLETED optimistically.
        await prisma.job.update({
          where: { id: j.id },
          data: { status: "COMPLETED" },
        }).catch(() => {});
        logAudit({
          action: "job.completed",
          entity: "Job",
          entityId: j.id,
          metadata: { ...meta, slurmJobId: j.slurmJobId, via: "health-monitor" },
        });
      } else if (sState !== j.status) {
        // State moved within squeue (PENDING → RUNNING, etc.). Sync DB; no alert.
        const mapped = sState === "RUNNING" ? "RUNNING" : sState === "PENDING" ? "PENDING" : null;
        if (mapped && mapped !== j.status) {
          await prisma.job.update({ where: { id: j.id }, data: { status: mapped } }).catch(() => {});
        }
      }
    }

    // Pass 2: drive from the live squeue snapshot — anything Slurm currently
    // sees as RUNNING/PENDING but the DB has marked terminal gets revived.
    // O(squeue size), no time-window, catches stale rows of any age.
    const liveIds = [...jobStateById.entries()]
      .filter(([, st]) => st === "RUNNING" || st === "PENDING")
      .map(([sid]) => parseInt(sid, 10))
      .filter((n) => Number.isFinite(n));
    if (liveIds.length > 0) {
      const stale = await prisma.job.findMany({
        where: {
          clusterId,
          slurmJobId: { in: liveIds },
          status: { in: ["COMPLETED", "FAILED", "CANCELLED"] },
        },
        select: { id: true, slurmJobId: true, status: true },
      });
      for (const j of stale) {
        const sState = jobStateById.get(String(j.slurmJobId));
        const mapped = sState === "RUNNING" ? "RUNNING" : "PENDING";
        await prisma.job.update({
          where: { id: j.id },
          data: { status: mapped, exitCode: null },
        }).catch(() => {});
        logAudit({
          action: "job.revived",
          entity: "Job",
          entityId: j.id,
          metadata: { ...meta, slurmJobId: j.slurmJobId, from: j.status, to: mapped, via: "health-monitor" },
        });
      }
    }
  } catch (err) {
    errors.push(`job reconcile failed: ${err instanceof Error ? err.message : "unknown"}`);
  }

  // Downgrade cluster status if slurmctld is unreachable (UI + status badge reflect it).
  if (!slurmctldUp && cluster.status === "ACTIVE") {
    await prisma.cluster.update({ where: { id: clusterId }, data: { status: "DEGRADED" } }).catch(() => {});
  } else if (slurmctldUp && cluster.status === "DEGRADED") {
    await prisma.cluster.update({ where: { id: clusterId }, data: { status: "ACTIVE" } }).catch(() => {});
  }

  cache.set(clusterId, {
    clusterId,
    clusterName: cluster.name,
    checkedAt: new Date().toISOString(),
    slurmctldUp,
    slurmctldMessage: pingBody.slice(0, 200) || undefined,
    nodes,
    storage,
    jobsTracked: jobStateById.size,
    pendingCount,
    runningCount,
    heldCount,
    oldestPendingSeconds,
    pendingByReason: Array.from(pendingByReason.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    stuckJobs,
    errors,
  });
}

let tickHandle: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const clusters = await prisma.cluster.findMany({
      where: { status: { in: ["ACTIVE", "DEGRADED"] } },
      select: { id: true },
    });
    // Poll clusters serially to keep bastion connection count low.
    for (const c of clusters) {
      try { await pollCluster(c.id); }
      catch (err) { console.warn(`[health] ${c.id} poll failed:`, err); }
    }
  } finally {
    ticking = false;
  }
}

export function startHealthMonitor(): void {
  if (tickHandle) return; // idempotent
  const intervalSec = Math.max(15, parseInt(process.env.SLURMUI_HEALTH_INTERVAL_SEC ?? "60", 10));
  console.log(`[health] poll interval: ${intervalSec}s`);
  // Kick off first tick after 10s so the server finishes starting up.
  setTimeout(() => {
    tick().catch((err) => console.warn("[health] initial tick failed:", err));
    tickHandle = setInterval(() => {
      tick().catch((err) => console.warn("[health] tick failed:", err));
    }, intervalSec * 1000);
  }, 10_000);
}
