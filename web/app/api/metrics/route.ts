import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAllHealth } from "@/lib/health-monitor";

/**
 * Prometheus metrics endpoint.
 * Scrape with:
 *   scrape_configs:
 *     - job_name: slurmui
 *       metrics_path: /api/metrics
 *       bearer_token: <METRICS_TOKEN>
 *       static_configs:
 *         - targets: ['slurmui.example.com']
 *
 * Optional auth via METRICS_TOKEN env var. If unset, endpoint is public.
 */
export async function GET(req: NextRequest) {
  const scrapeStart = Date.now();
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
    type: "gauge" | "counter" | "histogram" | "summary",
    help: string,
    values: Array<{ labels?: Record<string, string | number>; value: number }>,
  ) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const { labels, value } of values) {
      if (labels && Object.keys(labels).length > 0) {
        const labelStr = Object.entries(labels)
          .map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
          .join(",");
        lines.push(`${name}{${labelStr}} ${value}`);
      } else {
        lines.push(`${name} ${value}`);
      }
    }
    lines.push("");
  };

  try {
    const now = Date.now();
    const sinceDay = new Date(now - 24 * 3600_000);
    const sinceHour = new Date(now - 3600_000);
    const since5m = new Date(now - 5 * 60_000);

    // ──────────────── Clusters ────────────────
    const clusters = await prisma.cluster.findMany({
      select: {
        id: true,
        name: true,
        status: true,
        connectionMode: true,
        sshBastion: true,
        createdAt: true,
        config: true,
      },
    });
    const clusterNameById = new Map(clusters.map((c) => [c.id, c.name]));

    const clusterStatusCounts = new Map<string, number>();
    const connectionModeCounts = new Map<string, number>();
    const bastionCount = { yes: 0, no: 0 };
    for (const c of clusters) {
      clusterStatusCounts.set(c.status, (clusterStatusCounts.get(c.status) ?? 0) + 1);
      connectionModeCounts.set(c.connectionMode, (connectionModeCounts.get(c.connectionMode) ?? 0) + 1);
      if (c.sshBastion) bastionCount.yes++;
      else bastionCount.no++;
    }

    addMetric("slurmui_clusters_total", "gauge", "Total number of clusters by status",
      Array.from(clusterStatusCounts.entries()).map(([status, count]) => ({ labels: { status }, value: count }))
    );
    addMetric("slurmui_clusters_by_mode", "gauge", "Total number of clusters by connection mode",
      Array.from(connectionModeCounts.entries()).map(([mode, count]) => ({ labels: { mode }, value: count }))
    );
    addMetric("slurmui_clusters_by_bastion", "gauge", "Clusters split by whether SSH goes through a bastion", [
      { labels: { bastion: "true" }, value: bastionCount.yes },
      { labels: { bastion: "false" }, value: bastionCount.no },
    ]);

    // ──────────────── Per-cluster config breakdown ────────────────
    const clusterInfo: Array<{ labels: Record<string, string>; value: number }> = [];
    const nodeCount: Array<{ labels: Record<string, string>; value: number }> = [];
    const nodeCpus: Array<{ labels: Record<string, string>; value: number }> = [];
    const nodeGpus: Array<{ labels: Record<string, string>; value: number }> = [];
    const nodeMemory: Array<{ labels: Record<string, string>; value: number }> = [];
    const partitionCount: Array<{ labels: Record<string, string>; value: number }> = [];
    const partitionNodeCount: Array<{ labels: Record<string, string>; value: number }> = [];
    const storageCount: Array<{ labels: Record<string, string>; value: number }> = [];
    const storageByType: Array<{ labels: Record<string, string>; value: number }> = [];
    const packageCount: Array<{ labels: Record<string, string>; value: number }> = [];
    const pythonPackageCount: Array<{ labels: Record<string, string>; value: number }> = [];
    const envVarCount: Array<{ labels: Record<string, string>; value: number }> = [];
    const clusterAgeSeconds: Array<{ labels: Record<string, string>; value: number }> = [];

    for (const c of clusters) {
      const config = (c.config ?? {}) as Record<string, unknown>;
      const hosts = (config.slurm_hosts_entries ?? []) as Array<{ hostname?: string }>;
      const nodes = (config.slurm_nodes ?? []) as Array<{ expression?: string; cpus?: number; gpus?: number; memory_mb?: number }>;
      const partitions = (config.slurm_partitions ?? []) as Array<{ name: string; nodes?: string }>;
      const mounts = (config.storage_mounts ?? []) as Array<{ type?: string }>;
      const pkgs = (config.installed_packages ?? []) as string[];
      const pyPkgs = (config.python_packages ?? []) as unknown[];
      const env = (config.os_environment ?? []) as unknown[];

      const labels = { cluster_id: c.id, cluster: c.name };
      clusterInfo.push({
        labels: { ...labels, status: c.status, mode: c.connectionMode, bastion: String(c.sshBastion) },
        value: 1,
      });
      nodeCount.push({ labels, value: hosts.length });
      partitionCount.push({ labels, value: partitions.length });
      storageCount.push({ labels, value: mounts.length });
      packageCount.push({ labels, value: pkgs.length });
      pythonPackageCount.push({ labels, value: pyPkgs.length });
      envVarCount.push({ labels, value: env.length });
      clusterAgeSeconds.push({ labels, value: Math.floor((now - c.createdAt.getTime()) / 1000) });

      // Sum across declared nodes.
      let totalCpus = 0, totalGpus = 0, totalMem = 0;
      for (const n of nodes) {
        totalCpus += n.cpus ?? 0;
        totalGpus += n.gpus ?? 0;
        totalMem += n.memory_mb ?? 0;
      }
      nodeCpus.push({ labels, value: totalCpus });
      nodeGpus.push({ labels, value: totalGpus });
      nodeMemory.push({ labels, value: totalMem });

      // Per-partition node cardinality.
      for (const p of partitions) {
        const assigned = p.nodes === "ALL"
          ? hosts.length
          : (p.nodes ?? "").split(",").filter(Boolean).length;
        partitionNodeCount.push({
          labels: { ...labels, partition: p.name },
          value: assigned,
        });
      }

      // Storage mounts split by backend type.
      const byType = new Map<string, number>();
      for (const m of mounts) {
        const t = m.type ?? "unknown";
        byType.set(t, (byType.get(t) ?? 0) + 1);
      }
      for (const [t, n] of byType) {
        storageByType.push({ labels: { ...labels, type: t }, value: n });
      }
    }

    addMetric("slurmui_cluster_info", "gauge", "Cluster metadata (value always 1). One series per cluster.", clusterInfo);
    addMetric("slurmui_cluster_nodes", "gauge", "Number of configured nodes per cluster", nodeCount);
    addMetric("slurmui_cluster_cpus_total", "gauge", "Sum of declared CPUs across cluster nodes", nodeCpus);
    addMetric("slurmui_cluster_gpus_total", "gauge", "Sum of declared GPUs across cluster nodes", nodeGpus);
    addMetric("slurmui_cluster_memory_mb_total", "gauge", "Sum of declared memory (MiB) across cluster nodes", nodeMemory);
    addMetric("slurmui_cluster_partitions", "gauge", "Number of configured partitions per cluster", partitionCount);
    addMetric("slurmui_cluster_partition_nodes", "gauge", "Number of nodes assigned to each partition", partitionNodeCount);
    addMetric("slurmui_cluster_storage_mounts", "gauge", "Number of storage mounts per cluster", storageCount);
    addMetric("slurmui_cluster_storage_mounts_by_type", "gauge", "Storage mounts per cluster by backend type", storageByType);
    addMetric("slurmui_cluster_apt_packages", "gauge", "Number of tracked apt packages per cluster", packageCount);
    addMetric("slurmui_cluster_python_packages", "gauge", "Number of tracked Python packages per cluster", pythonPackageCount);
    addMetric("slurmui_cluster_env_vars", "gauge", "Number of tracked environment variables per cluster", envVarCount);
    addMetric("slurmui_cluster_age_seconds", "gauge", "Seconds since the cluster row was created", clusterAgeSeconds);

    // ──────────────── Jobs ────────────────
    const [
      jobsByStatus,
      jobsByClusterStatus,
      jobsByClusterPartitionStatus,
      jobsByExitCode,
      jobs24h,
      jobs1h,
      jobs5m,
      runningJobsWithStart,
      finishedJobsRecent,
    ] = await Promise.all([
      prisma.job.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.job.groupBy({ by: ["clusterId", "status"], _count: { _all: true } }),
      prisma.job.groupBy({ by: ["clusterId", "partition", "status"], _count: { _all: true } }),
      prisma.job.groupBy({
        by: ["exitCode"],
        _count: { _all: true },
        where: { status: { in: ["COMPLETED", "FAILED"] } },
      }),
      prisma.job.groupBy({ by: ["status"], _count: { _all: true }, where: { createdAt: { gte: sinceDay } } }),
      prisma.job.groupBy({ by: ["status"], _count: { _all: true }, where: { createdAt: { gte: sinceHour } } }),
      prisma.job.groupBy({ by: ["status"], _count: { _all: true }, where: { createdAt: { gte: since5m } } }),
      prisma.job.findMany({
        where: { status: "RUNNING" },
        select: { clusterId: true, createdAt: true, updatedAt: true },
      }),
      prisma.job.findMany({
        where: { status: { in: ["COMPLETED", "FAILED", "CANCELLED"] }, updatedAt: { gte: sinceDay } },
        select: { clusterId: true, status: true, createdAt: true, updatedAt: true },
      }),
    ]);

    addMetric("slurmui_jobs_total", "gauge", "Total jobs by status (lifetime)",
      jobsByStatus.map((j) => ({ labels: { status: j.status }, value: j._count._all }))
    );
    addMetric("slurmui_cluster_jobs", "gauge", "Jobs per cluster by status (lifetime)",
      jobsByClusterStatus.map((j) => ({
        labels: {
          cluster_id: j.clusterId,
          cluster: clusterNameById.get(j.clusterId) ?? "unknown",
          status: j.status,
        },
        value: j._count._all,
      }))
    );
    addMetric("slurmui_cluster_partition_jobs", "gauge", "Jobs per (cluster, partition, status)",
      jobsByClusterPartitionStatus.map((j) => ({
        labels: {
          cluster_id: j.clusterId,
          cluster: clusterNameById.get(j.clusterId) ?? "unknown",
          partition: j.partition,
          status: j.status,
        },
        value: j._count._all,
      }))
    );
    addMetric("slurmui_jobs_by_exit_code", "gauge", "Completed/failed jobs bucketed by exit code",
      jobsByExitCode.map((j) => ({ labels: { exit_code: String(j.exitCode ?? -1) }, value: j._count._all }))
    );
    addMetric("slurmui_jobs_24h", "gauge", "Jobs created in the last 24h by status",
      jobs24h.map((j) => ({ labels: { status: j.status }, value: j._count._all }))
    );
    addMetric("slurmui_jobs_1h", "gauge", "Jobs created in the last 1h by status",
      jobs1h.map((j) => ({ labels: { status: j.status }, value: j._count._all }))
    );
    addMetric("slurmui_jobs_5m", "gauge", "Jobs created in the last 5m by status",
      jobs5m.map((j) => ({ labels: { status: j.status }, value: j._count._all }))
    );

    // Currently-running job ages (wall-clock seconds since submit). Reduce to
    // a simple summary to avoid per-job cardinality.
    const runningDurations = runningJobsWithStart.map((j) => (now - j.createdAt.getTime()) / 1000);
    const runningStats = statSummary(runningDurations);
    const runningPerCluster = new Map<string, number>();
    for (const j of runningJobsWithStart) {
      runningPerCluster.set(j.clusterId, (runningPerCluster.get(j.clusterId) ?? 0) + 1);
    }
    addMetric("slurmui_jobs_running_count", "gauge", "Jobs currently in RUNNING state per cluster",
      Array.from(runningPerCluster.entries()).map(([clusterId, count]) => ({
        labels: { cluster_id: clusterId, cluster: clusterNameById.get(clusterId) ?? "unknown" },
        value: count,
      }))
    );
    addMetric("slurmui_running_job_age_seconds", "gauge",
      "Statistics over the wall-clock age of RUNNING jobs", [
        { labels: { stat: "min" }, value: runningStats.min },
        { labels: { stat: "p50" }, value: runningStats.p50 },
        { labels: { stat: "p90" }, value: runningStats.p90 },
        { labels: { stat: "p99" }, value: runningStats.p99 },
        { labels: { stat: "max" }, value: runningStats.max },
        { labels: { stat: "count" }, value: runningStats.count },
      ]
    );

    // Finished-job duration histogram (updatedAt - createdAt). 24h window.
    const BUCKETS = [10, 30, 60, 300, 900, 1800, 3600, 21600, 86400];
    const hist: Record<string, Array<{ labels: Record<string, string>; value: number }>> = {};
    for (const status of ["COMPLETED", "FAILED", "CANCELLED"]) hist[status] = [];
    const perClusterStatusDurations = new Map<string, Record<string, number[]>>();
    for (const j of finishedJobsRecent) {
      const dur = (j.updatedAt.getTime() - j.createdAt.getTime()) / 1000;
      const key = j.clusterId;
      if (!perClusterStatusDurations.has(key)) perClusterStatusDurations.set(key, {});
      const byStatus = perClusterStatusDurations.get(key)!;
      (byStatus[j.status] ??= []).push(dur);
    }
    const histSeries: Array<{ labels: Record<string, string>; value: number }> = [];
    const countSeries: Array<{ labels: Record<string, string>; value: number }> = [];
    const sumSeries: Array<{ labels: Record<string, string>; value: number }> = [];
    for (const [clusterId, byStatus] of perClusterStatusDurations) {
      for (const [status, durations] of Object.entries(byStatus)) {
        const labels = { cluster_id: clusterId, cluster: clusterNameById.get(clusterId) ?? "unknown", status };
        // Cumulative buckets
        const sorted = [...durations].sort((a, b) => a - b);
        for (const le of BUCKETS) {
          const c = sorted.filter((d) => d <= le).length;
          histSeries.push({ labels: { ...labels, le: String(le) }, value: c });
        }
        histSeries.push({ labels: { ...labels, le: "+Inf" }, value: sorted.length });
        countSeries.push({ labels, value: sorted.length });
        sumSeries.push({ labels, value: sorted.reduce((a, b) => a + b, 0) });
      }
    }
    // Emit as three parallel gauges (not a proper Prometheus histogram,
    // since Prom histograms need stable _bucket / _count / _sum siblings
    // with the same base name — done here).
    addMetric("slurmui_job_duration_seconds_bucket", "gauge",
      "Cumulative count of finished jobs in the last 24h with duration ≤ le seconds", histSeries);
    addMetric("slurmui_job_duration_seconds_count", "gauge",
      "Count of finished jobs in the last 24h", countSeries);
    addMetric("slurmui_job_duration_seconds_sum", "gauge",
      "Summed duration (seconds) of finished jobs in the last 24h", sumSeries);

    // Most recent submit / completion timestamps per cluster (for staleness alerts).
    const lastSubmit = await prisma.job.groupBy({
      by: ["clusterId"],
      _max: { createdAt: true },
    });
    addMetric("slurmui_cluster_last_submit_timestamp_seconds", "gauge",
      "Unix timestamp of the most recent job submission per cluster",
      lastSubmit.map((r) => ({
        labels: { cluster_id: r.clusterId, cluster: clusterNameById.get(r.clusterId) ?? "unknown" },
        value: r._max.createdAt ? Math.floor(r._max.createdAt.getTime() / 1000) : 0,
      }))
    );
    const lastFinished = await prisma.job.groupBy({
      by: ["clusterId"],
      _max: { updatedAt: true },
      where: { status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } },
    });
    addMetric("slurmui_cluster_last_finished_timestamp_seconds", "gauge",
      "Unix timestamp of the most recent finished job per cluster",
      lastFinished.map((r) => ({
        labels: { cluster_id: r.clusterId, cluster: clusterNameById.get(r.clusterId) ?? "unknown" },
        value: r._max.updatedAt ? Math.floor(r._max.updatedAt.getTime() / 1000) : 0,
      }))
    );

    // ──────────────── Users ────────────────
    const [auraUsers, clusterUsersByStatus, userJobCountsAll] = await Promise.all([
      prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
      prisma.clusterUser.groupBy({ by: ["clusterId", "status"], _count: { _all: true } }),
      prisma.job.groupBy({
        by: ["userId", "clusterId"],
        _count: { _all: true },
        where: { createdAt: { gte: sinceDay } },
      }),
    ]);

    addMetric("slurmui_users_total", "gauge", "SlurmUI users by role",
      auraUsers.map((u) => ({ labels: { role: u.role }, value: u._count._all }))
    );
    addMetric("slurmui_cluster_users", "gauge", "Users provisioned on each cluster by status",
      clusterUsersByStatus.map((cu) => ({
        labels: {
          cluster_id: cu.clusterId,
          cluster: clusterNameById.get(cu.clusterId) ?? "unknown",
          status: cu.status,
        },
        value: cu._count._all,
      }))
    );

    // Most active users in the last 24h, capped at top 20 to keep cardinality sane.
    const topUsers = [...userJobCountsAll].sort((a, b) => b._count._all - a._count._all).slice(0, 20);
    if (topUsers.length > 0) {
      const userIds = Array.from(new Set(topUsers.map((r) => r.userId)));
      const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, unixUsername: true, email: true },
      });
      const nameById = new Map(users.map((u) => [u.id, u.unixUsername ?? u.email.split("@")[0]]));
      addMetric("slurmui_top_user_jobs_24h", "gauge",
        "Jobs submitted in the last 24h — top 20 users per cluster",
        topUsers.map((r) => ({
          labels: {
            cluster_id: r.clusterId,
            cluster: clusterNameById.get(r.clusterId) ?? "unknown",
            user: nameById.get(r.userId) ?? r.userId.slice(0, 8),
          },
          value: r._count._all,
        }))
      );
    }

    // ──────────────── App sessions ────────────────
    const appSessions = await prisma.appSession.groupBy({
      by: ["clusterId", "status", "type"],
      _count: { _all: true },
    });
    addMetric("slurmui_app_sessions", "gauge", "Application sessions by cluster, type, and status",
      appSessions.map((a) => ({
        labels: {
          cluster_id: a.clusterId,
          cluster: clusterNameById.get(a.clusterId) ?? "unknown",
          type: a.type,
          status: a.status,
        },
        value: a._count._all,
      }))
    );

    // ──────────────── SSH keys ────────────────
    const sshKeys = await prisma.sshKey.findMany({
      select: { name: true, createdAt: true, _count: { select: { clusters: true } } },
    });
    addMetric("slurmui_ssh_keys_total", "gauge", "Total number of SSH keys", [{ value: sshKeys.length }]);
    const unusedKeys = sshKeys.filter((k) => k._count.clusters === 0).length;
    addMetric("slurmui_ssh_keys_unused", "gauge", "SSH keys not attached to any cluster", [{ value: unusedKeys }]);
    addMetric("slurmui_ssh_key_clusters_using", "gauge", "Number of clusters using each SSH key",
      sshKeys.map((k) => ({ labels: { key: k.name }, value: k._count.clusters }))
    );

    // ──────────────── Job templates ────────────────
    const tplCounts = await prisma.jobTemplate.groupBy({
      by: ["clusterId"],
      _count: { _all: true },
    });
    addMetric("slurmui_cluster_templates", "gauge", "Number of saved job templates per cluster",
      tplCounts.map((t) => ({
        labels: { cluster_id: t.clusterId, cluster: clusterNameById.get(t.clusterId) ?? "unknown" },
        value: t._count._all,
      }))
    );
    const tplTotal = await prisma.jobTemplate.count();
    addMetric("slurmui_templates_total", "gauge", "Total saved job templates across all clusters", [{ value: tplTotal }]);

    // ──────────────── Background tasks ────────────────
    const [bgByStatus, bgRunning, bgFailed24h, bgByTypeStatus] = await Promise.all([
      prisma.backgroundTask.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.backgroundTask.findMany({
        where: { status: "running" },
        select: { clusterId: true, type: true, createdAt: true },
      }),
      prisma.backgroundTask.groupBy({
        by: ["type"],
        _count: { _all: true },
        where: { status: "failed", completedAt: { gte: sinceDay } },
      }),
      prisma.backgroundTask.groupBy({
        by: ["type", "status"],
        _count: { _all: true },
      }),
    ]);

    addMetric("slurmui_background_tasks_total", "gauge", "Background tasks by status (lifetime)",
      bgByStatus.map((t) => ({ labels: { status: t.status }, value: t._count._all }))
    );
    addMetric("slurmui_background_tasks_by_type", "gauge", "Background tasks by type and status",
      bgByTypeStatus.map((t) => ({ labels: { type: t.type, status: t.status }, value: t._count._all }))
    );
    addMetric("slurmui_background_tasks_running", "gauge", "Currently-running background tasks per cluster + type",
      Array.from(bgRunning.reduce((acc, t) => {
        const key = `${t.clusterId}|${t.type}`;
        acc.set(key, (acc.get(key) ?? 0) + 1);
        return acc;
      }, new Map<string, number>()).entries()).map(([key, count]) => {
        const [clusterId, type] = key.split("|");
        return {
          labels: {
            cluster_id: clusterId,
            cluster: clusterNameById.get(clusterId) ?? "unknown",
            type,
          },
          value: count,
        };
      })
    );
    // Longest-running task (staleness alerts: "this task has been running > 1h").
    const oldestRunning = bgRunning.reduce((min, t) => Math.min(min, t.createdAt.getTime()), now);
    addMetric("slurmui_background_task_oldest_age_seconds", "gauge",
      "Wall-clock age of the oldest RUNNING background task (0 if none)",
      [{ value: bgRunning.length === 0 ? 0 : Math.floor((now - oldestRunning) / 1000) }]
    );
    addMetric("slurmui_background_tasks_failed_24h", "gauge", "Background tasks that failed in the last 24h by type",
      bgFailed24h.map((t) => ({ labels: { type: t.type }, value: t._count._all }))
    );

    // ──────────────── Audit log ────────────────
    const [auditByAction, auditTotal, audit1h] = await Promise.all([
      prisma.auditLog.groupBy({ by: ["action"], _count: { _all: true }, where: { createdAt: { gte: sinceDay } } }),
      prisma.auditLog.count(),
      prisma.auditLog.groupBy({ by: ["action"], _count: { _all: true }, where: { createdAt: { gte: sinceHour } } }),
    ]);
    addMetric("slurmui_audit_logs_24h", "gauge", "Audit log events in the last 24h by action",
      auditByAction.map((a) => ({ labels: { action: a.action }, value: a._count._all }))
    );
    addMetric("slurmui_audit_logs_1h", "gauge", "Audit log events in the last 1h by action",
      audit1h.map((a) => ({ labels: { action: a.action }, value: a._count._all }))
    );
    addMetric("slurmui_audit_logs_total", "counter", "Total audit log entries (lifetime)", [{ value: auditTotal }]);

    // ──────────────── Git sync ────────────────
    const gitSyncRow = await prisma.setting.findUnique({ where: { key: "git_sync_config" } });
    if (gitSyncRow) {
      try {
        const cfg = JSON.parse(gitSyncRow.value);
        addMetric("slurmui_git_sync_enabled", "gauge", "1 if git sync is enabled",
          [{ value: cfg.enabled ? 1 : 0 }]
        );
        if (cfg.lastSyncAt) {
          addMetric("slurmui_git_sync_last_sync_timestamp_seconds", "gauge",
            "Unix timestamp of the most recent git sync attempt",
            [{ value: Math.floor(new Date(cfg.lastSyncAt).getTime() / 1000) }]
          );
        }
        if (cfg.lastSyncStatus) {
          addMetric("slurmui_git_sync_last_success", "gauge",
            "1 if the last git sync succeeded, 0 otherwise",
            [{ value: cfg.lastSyncStatus === "success" ? 1 : 0 }]
          );
        }
      } catch {}
    }

    // ──────────────── Health monitor ────────────────
    const healthSnapshots = getAllHealth();
    const BAD_NODE_STATES = ["down", "drain", "fail", "err", "boot_fail", "not_responding"];
    const isBadNodeState = (s: string) => BAD_NODE_STATES.some((b) => s.includes(b));

    const healthCtlUp: Array<{ labels: Record<string, string>; value: number }> = [];
    const healthCheckedAt: Array<{ labels: Record<string, string>; value: number }> = [];
    const healthCheckAge: Array<{ labels: Record<string, string>; value: number }> = [];
    const healthJobsTracked: Array<{ labels: Record<string, string>; value: number }> = [];
    const healthErrors: Array<{ labels: Record<string, string>; value: number }> = [];
    const healthNodesTotal: Array<{ labels: Record<string, string>; value: number }> = [];
    const healthNodesUnhealthy: Array<{ labels: Record<string, string>; value: number }> = [];
    const healthNodesByState: Array<{ labels: Record<string, string>; value: number }> = [];
    const healthNodeInfo: Array<{ labels: Record<string, string>; value: number }> = [];
    const healthStorageMounted: Array<{ labels: Record<string, string>; value: number }> = [];

    for (const h of healthSnapshots) {
      const baseLabels = { cluster_id: h.clusterId, cluster: h.clusterName };
      const checkedMs = new Date(h.checkedAt).getTime();

      healthCtlUp.push({ labels: baseLabels, value: h.slurmctldUp ? 1 : 0 });
      healthCheckedAt.push({ labels: baseLabels, value: Math.floor(checkedMs / 1000) });
      healthCheckAge.push({ labels: baseLabels, value: Math.max(0, Math.floor((now - checkedMs) / 1000)) });
      healthJobsTracked.push({ labels: baseLabels, value: h.jobsTracked });
      healthErrors.push({ labels: baseLabels, value: h.errors.length });

      healthNodesTotal.push({ labels: baseLabels, value: h.nodes.length });
      healthNodesUnhealthy.push({
        labels: baseLabels,
        value: h.nodes.filter((n) => isBadNodeState(n.state)).length,
      });

      const byState = new Map<string, number>();
      for (const n of h.nodes) {
        byState.set(n.state, (byState.get(n.state) ?? 0) + 1);
        healthNodeInfo.push({
          labels: { ...baseLabels, node: n.name, state: n.state },
          value: isBadNodeState(n.state) ? 0 : 1,
        });
      }
      for (const [state, count] of byState) {
        healthNodesByState.push({ labels: { ...baseLabels, state }, value: count });
      }

      for (const s of h.storage) {
        healthStorageMounted.push({
          labels: { ...baseLabels, host: s.hostname, mount_id: s.mountId, mount_path: s.mountPath },
          value: s.mounted ? 1 : 0,
        });
      }
    }

    addMetric("slurmui_health_slurmctld_up", "gauge", "1 if slurmctld responded to scontrol ping at last health poll", healthCtlUp);
    addMetric("slurmui_health_last_check_timestamp_seconds", "gauge", "Unix timestamp of the last health poll per cluster", healthCheckedAt);
    addMetric("slurmui_health_last_check_age_seconds", "gauge", "Seconds since the last completed health poll per cluster", healthCheckAge);
    addMetric("slurmui_health_jobs_tracked", "gauge", "Number of jobs squeue reported at last health poll", healthJobsTracked);
    addMetric("slurmui_health_poll_errors", "gauge", "Number of errors in the last health poll per cluster", healthErrors);
    addMetric("slurmui_health_nodes_total", "gauge", "Total nodes reported by sinfo at last health poll", healthNodesTotal);
    addMetric("slurmui_health_nodes_unhealthy", "gauge", "Nodes in down/drain/fail/err/boot_fail/not_responding at last health poll", healthNodesUnhealthy);
    addMetric("slurmui_health_nodes_by_state", "gauge", "Node count per sinfo state at last health poll", healthNodesByState);
    addMetric("slurmui_health_node_up", "gauge", "1 if node is in a healthy state, 0 otherwise (one series per node)", healthNodeInfo);
    addMetric("slurmui_health_storage_mounted", "gauge", "1 if storage mount is present on the worker, 0 otherwise", healthStorageMounted);

    // ──────────────── Queue state (from health monitor) ────────────────
    const queuePending: Array<{ labels: Record<string, string>; value: number }> = [];
    const queueRunning: Array<{ labels: Record<string, string>; value: number }> = [];
    const queueHeld: Array<{ labels: Record<string, string>; value: number }> = [];
    const queueOldest: Array<{ labels: Record<string, string>; value: number }> = [];
    const queueByReason: Array<{ labels: Record<string, string>; value: number }> = [];
    const queueStuck: Array<{ labels: Record<string, string>; value: number }> = [];
    for (const h of healthSnapshots) {
      const base = { cluster_id: h.clusterId, cluster: h.clusterName };
      queuePending.push({ labels: base, value: h.pendingCount });
      queueRunning.push({ labels: base, value: h.runningCount });
      queueHeld.push({ labels: base, value: h.heldCount });
      queueOldest.push({ labels: base, value: h.oldestPendingSeconds });
      queueStuck.push({ labels: base, value: h.stuckJobs.length });
      for (const r of h.pendingByReason) {
        queueByReason.push({ labels: { ...base, reason: r.reason }, value: r.count });
      }
    }
    addMetric("slurmui_queue_pending_jobs", "gauge", "Pending jobs in squeue per cluster at last health poll", queuePending);
    addMetric("slurmui_queue_running_jobs", "gauge", "Running jobs in squeue per cluster at last health poll", queueRunning);
    addMetric("slurmui_queue_held_jobs", "gauge", "Held jobs (JobHeldUser/JobHeldAdmin) per cluster at last health poll", queueHeld);
    addMetric("slurmui_queue_oldest_pending_seconds", "gauge", "Age (submit to now) of the oldest pending job per cluster", queueOldest);
    addMetric("slurmui_queue_pending_by_reason", "gauge", "Pending jobs per cluster bucketed by sinfo reason code", queueByReason);
    addMetric("slurmui_queue_stuck_jobs", "gauge", "Jobs classified stuck by health-monitor (held, dependency-never-satisfied, or long-pending)", queueStuck);

    // ──────────────── Scrape info ────────────────
    addMetric("slurmui_scrape_timestamp_seconds", "gauge", "Unix timestamp of this scrape",
      [{ value: Math.floor(Date.now() / 1000) }]
    );
    addMetric("slurmui_scrape_duration_seconds", "gauge", "How long it took to compute this response",
      [{ value: (Date.now() - scrapeStart) / 1000 }]
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

// Simple percentile helper used by slurmui_running_job_age_seconds.
function statSummary(values: number[]) {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, p50: 0, p90: 0, p99: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: pick(0.5),
    p90: pick(0.9),
    p99: pick(0.99),
  };
}
