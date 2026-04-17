import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Prometheus metrics endpoint.
 * Scrape with:
 *   scrape_configs:
 *     - job_name: aura
 *       metrics_path: /api/metrics
 *       bearer_token: <METRICS_TOKEN>
 *       static_configs:
 *         - targets: ['aura.example.com']
 *
 * Optional auth via METRICS_TOKEN env var. If unset, endpoint is public.
 */
export async function GET(req: NextRequest) {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const authHeader = req.headers.get("authorization") ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (provided !== token) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const lines: string[] = [];

  const addMetric = (
    name: string,
    type: "gauge" | "counter",
    help: string,
    values: Array<{ labels?: Record<string, string | number>; value: number }>,
  ) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const { labels, value } of values) {
      if (labels && Object.keys(labels).length > 0) {
        const labelStr = Object.entries(labels)
          .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"').replace(/\\/g, "\\\\")}"`)
          .join(",");
        lines.push(`${name}{${labelStr}} ${value}`);
      } else {
        lines.push(`${name} ${value}`);
      }
    }
    lines.push("");
  };

  try {
    // ---- Clusters by status ----
    const clusters = await prisma.cluster.findMany({
      select: { id: true, name: true, status: true, connectionMode: true, config: true },
    });

    const clusterStatusCounts = new Map<string, number>();
    const connectionModeCounts = new Map<string, number>();
    for (const c of clusters) {
      clusterStatusCounts.set(c.status, (clusterStatusCounts.get(c.status) ?? 0) + 1);
      connectionModeCounts.set(c.connectionMode, (connectionModeCounts.get(c.connectionMode) ?? 0) + 1);
    }

    addMetric("aura_clusters_total", "gauge", "Total number of clusters by status",
      Array.from(clusterStatusCounts.entries()).map(([status, count]) => ({
        labels: { status }, value: count,
      })),
    );

    addMetric("aura_clusters_by_mode", "gauge", "Total number of clusters by connection mode",
      Array.from(connectionModeCounts.entries()).map(([mode, count]) => ({
        labels: { mode }, value: count,
      })),
    );

    // ---- Per-cluster info: nodes, storages, packages ----
    const clusterInfo: Array<{ labels: Record<string, string>; value: number }> = [];
    const nodeCount: Array<{ labels: Record<string, string>; value: number }> = [];
    const storageCount: Array<{ labels: Record<string, string>; value: number }> = [];
    const packageCount: Array<{ labels: Record<string, string>; value: number }> = [];

    for (const c of clusters) {
      const config = (c.config ?? {}) as Record<string, unknown>;
      const hosts = (config.slurm_hosts_entries ?? []) as Array<unknown>;
      const mounts = (config.storage_mounts ?? []) as Array<unknown>;
      const pkgs = (config.installed_packages ?? []) as Array<unknown>;

      const labels = { cluster_id: c.id, cluster: c.name };
      clusterInfo.push({
        labels: { ...labels, status: c.status, mode: c.connectionMode },
        value: 1,
      });
      nodeCount.push({ labels, value: hosts.length });
      storageCount.push({ labels, value: mounts.length });
      packageCount.push({ labels, value: pkgs.length });
    }

    addMetric("aura_cluster_info", "gauge", "Cluster metadata (value always 1)", clusterInfo);
    addMetric("aura_cluster_nodes", "gauge", "Number of configured nodes per cluster", nodeCount);
    addMetric("aura_cluster_storage_mounts", "gauge", "Number of storage mounts per cluster", storageCount);
    addMetric("aura_cluster_packages", "gauge", "Number of installed packages per cluster", packageCount);

    // ---- Jobs by status (overall + per cluster) ----
    const jobsByStatus = await prisma.job.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    addMetric("aura_jobs_total", "gauge", "Total jobs by status",
      jobsByStatus.map((j) => ({ labels: { status: j.status }, value: j._count._all })),
    );

    const jobsByClusterStatus = await prisma.job.groupBy({
      by: ["clusterId", "status"],
      _count: { _all: true },
    });
    const clusterNameById = new Map(clusters.map((c) => [c.id, c.name]));
    addMetric("aura_cluster_jobs", "gauge", "Total jobs per cluster by status",
      jobsByClusterStatus.map((j) => ({
        labels: {
          cluster_id: j.clusterId,
          cluster: clusterNameById.get(j.clusterId) ?? "unknown",
          status: j.status,
        },
        value: j._count._all,
      })),
    );

    // ---- Active users (per cluster users) ----
    const clusterUsersByStatus = await prisma.clusterUser.groupBy({
      by: ["clusterId", "status"],
      _count: { _all: true },
    });
    addMetric("aura_cluster_users", "gauge", "Users provisioned on each cluster by status",
      clusterUsersByStatus.map((cu) => ({
        labels: {
          cluster_id: cu.clusterId,
          cluster: clusterNameById.get(cu.clusterId) ?? "unknown",
          status: cu.status,
        },
        value: cu._count._all,
      })),
    );

    // ---- App sessions ----
    const appSessions = await prisma.appSession.groupBy({
      by: ["clusterId", "status", "type"],
      _count: { _all: true },
    });
    addMetric("aura_app_sessions", "gauge", "Application sessions by cluster, type, and status",
      appSessions.map((a) => ({
        labels: {
          cluster_id: a.clusterId,
          cluster: clusterNameById.get(a.clusterId) ?? "unknown",
          type: a.type,
          status: a.status,
        },
        value: a._count._all,
      })),
    );

    // ---- SSH keys ----
    const sshKeys = await prisma.sshKey.count();
    addMetric("aura_ssh_keys_total", "gauge", "Total number of SSH keys configured",
      [{ value: sshKeys }],
    );

    // ---- Aura users ----
    const auraUsers = await prisma.user.groupBy({
      by: ["role"],
      _count: { _all: true },
    });
    addMetric("aura_users_total", "gauge", "Total Aura users by role",
      auraUsers.map((u) => ({ labels: { role: u.role }, value: u._count._all })),
    );

    // ---- Background tasks ----
    const bgTasks = await prisma.backgroundTask.groupBy({
      by: ["type", "status"],
      _count: { _all: true },
    });
    addMetric("aura_background_tasks_total", "gauge", "Background tasks by type and status",
      bgTasks.map((t) => ({ labels: { type: t.type, status: t.status }, value: t._count._all })),
    );

    // ---- Audit logs (last 24h by action) ----
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const auditByAction = await prisma.auditLog.groupBy({
      by: ["action"],
      _count: { _all: true },
      where: { createdAt: { gte: since } },
    });
    addMetric("aura_audit_logs_last_24h", "gauge", "Audit log events in the last 24 hours by action",
      auditByAction.map((a) => ({ labels: { action: a.action }, value: a._count._all })),
    );

    const auditTotal = await prisma.auditLog.count();
    addMetric("aura_audit_logs_total", "counter", "Total audit log entries (lifetime)",
      [{ value: auditTotal }],
    );

    // ---- Scrape timestamp ----
    addMetric("aura_scrape_timestamp_seconds", "gauge", "Unix timestamp of this scrape",
      [{ value: Math.floor(Date.now() / 1000) }],
    );

    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return new Response(
      `# Error generating metrics: ${err instanceof Error ? err.message : "unknown"}\n`,
      { status: 500, headers: { "Content-Type": "text/plain" } },
    );
  }
}
