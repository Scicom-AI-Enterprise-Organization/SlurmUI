import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JobTable } from "@/components/jobs/job-table";
import { JobsLast24hChart } from "@/components/dashboard/jobs-last-24h-chart";
import { JobsStatusDonut } from "@/components/dashboard/jobs-status-donut";
import { StatCard } from "@/components/dashboard/stat-card";
import { DurationHistogram } from "@/components/dashboard/duration-histogram";
import { PerClusterSplit } from "@/components/dashboard/per-cluster-split";
import { ResourceHours7d } from "@/components/dashboard/resource-hours-7d";
import { ActivityHeatmap } from "@/components/dashboard/activity-heatmap";

// Pull #SBATCH --gres=gpu:N and --cpus-per-task=N out of a submission script.
function parseJobGresCpus(script: string): { gpus: number; cpus: number } {
  const gres = script.match(/#SBATCH\s+--gres=gpu(?::[^:\s]+)?:(\d+)/);
  const cpt = script.match(/#SBATCH\s+(?:--cpus-per-task|-c)[=\s]+(\d+)/);
  return {
    gpus: gres ? parseInt(gres[1], 10) || 0 : 0,
    cpus: cpt ? parseInt(cpt[1], 10) || 1 : 1,
  };
}

function parseJobName(script: string, id: string): string {
  const m = script.match(/#SBATCH\s+(?:--job-name|-J)[=\s]+(\S+)/);
  return m ? m[1] : `Job ${id.slice(0, 8)}`;
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/api/auth/signin");

  const userId = session.user.id;
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const since60d = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const [recentJobs, jobs7d, liveJobs, createdAt60d] = await Promise.all([
    prisma.job.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { cluster: { select: { name: true } } },
    }),
    prisma.job.findMany({
      where: { userId, createdAt: { gte: since7d } },
      select: {
        id: true, status: true, exitCode: true, createdAt: true, updatedAt: true,
        script: true, cluster: { select: { id: true, name: true } },
      },
    }),
    // User-scoped — every other panel on this page filters by userId, so
    // leaving liveJobs unscoped meant the "Jobs (24h)" tile (user-scope)
    // and the donut total (cluster-scope, multiplied by 24 hourly buckets)
    // disagreed wildly. Same scope across the dashboard now.
    prisma.job.findMany({
      where: { userId, status: { in: ["PENDING", "RUNNING"] } },
      select: {
        id: true, status: true, createdAt: true, slurmJobId: true,
        cluster: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.job.findMany({
      where: { userId, createdAt: { gte: since60d } },
      select: { createdAt: true },
    }),
  ]);

  // ---------- 24h rollup (for area chart + donut + totals) ----------
  const jobs24h = jobs7d.filter((j) => j.createdAt >= since24h);
  const buckets = Array.from({ length: 24 }, (_, i) => {
    const start = new Date(now.getTime() - (24 - i) * 60 * 60 * 1000);
    return {
      hour: `${String(start.getHours()).padStart(2, "0")}:00`,
      startMs: start.getTime(),
      endMs: start.getTime() + 60 * 60 * 1000,
      running: 0, completed: 0, failed: 0,
    };
  });
  // Terminal jobs are billed to the bucket of their createdAt.
  for (const j of jobs24h) {
    if (j.status !== "COMPLETED" && j.status !== "FAILED" && j.status !== "CANCELLED") continue;
    const diffHours = Math.floor((now.getTime() - j.createdAt.getTime()) / 3600_000);
    const idx = 23 - diffHours;
    if (idx < 0 || idx > 23) continue;
    const b = buckets[idx];
    if (j.status === "COMPLETED") b.completed += 1;
    else b.failed += 1;
  }
  // Live jobs (cluster-wide) are counted in every bucket where they were
  // actually running — so a long-lived vLLM submitted yesterday shows as a
  // flat "1" across all 24 hours, not as 0.
  for (const j of liveJobs) {
    const startedMs = j.createdAt.getTime();
    for (const b of buckets) {
      if (b.endMs <= startedMs) continue; // job hadn't started yet
      b.running += 1;
    }
  }
  const last24Totals = buckets.reduce(
    (acc, b) => ({ running: acc.running + b.running, completed: acc.completed + b.completed, failed: acc.failed + b.failed }),
    { running: 0, completed: 0, failed: 0 },
  );

  // ---------- KPI stats ----------
  const running = liveJobs.filter((j) => j.status === "RUNNING").length;
  const queued = liveJobs.filter((j) => j.status === "PENDING").length;
  const terminal24h = jobs24h.filter((j) => j.status !== "PENDING" && j.status !== "RUNNING");
  const completed24h = terminal24h.filter((j) => j.status === "COMPLETED").length;
  const successRate = terminal24h.length > 0
    ? Math.round((completed24h / terminal24h.length) * 100)
    : null;

  const durations24h = terminal24h
    .map((j) => (j.updatedAt.getTime() - j.createdAt.getTime()) / 1000)
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
  const medianDuration = durations24h.length > 0
    ? durations24h[Math.floor(durations24h.length / 2)]
    : null;

  let gpuHours7d = 0;
  let cpuHours7d = 0;
  for (const j of jobs7d) {
    if (j.status !== "COMPLETED" && j.status !== "FAILED" && j.status !== "CANCELLED") continue;
    const durSec = (j.updatedAt.getTime() - j.createdAt.getTime()) / 1000;
    if (durSec <= 0) continue;
    const { gpus, cpus } = parseJobGresCpus(j.script);
    gpuHours7d += (gpus * durSec) / 3600;
    cpuHours7d += (cpus * durSec) / 3600;
  }

  // ---------- Duration histogram (24h, finished only) ----------
  const durationBuckets = [
    { label: "<1m", max: 60, count: 0 },
    { label: "1–5m", max: 300, count: 0 },
    { label: "5–15m", max: 900, count: 0 },
    { label: "15–60m", max: 3600, count: 0 },
    { label: "1–4h", max: 14400, count: 0 },
    { label: "4h+", max: Infinity, count: 0 },
  ];
  for (const s of durations24h) {
    for (const b of durationBuckets) {
      if (s < b.max) { b.count += 1; break; }
    }
  }

  // ---------- Per-cluster split (24h) ----------
  const perClusterMap = new Map<string, { cluster: string; completed: number; failed: number; pending: number; running: number }>();
  for (const j of jobs24h) {
    const key = j.cluster?.name ?? "?";
    if (!perClusterMap.has(key)) {
      perClusterMap.set(key, { cluster: key, completed: 0, failed: 0, pending: 0, running: 0 });
    }
    const e = perClusterMap.get(key)!;
    if (j.status === "COMPLETED") e.completed += 1;
    else if (j.status === "FAILED" || j.status === "CANCELLED") e.failed += 1;
    else if (j.status === "RUNNING") e.running += 1;
    else if (j.status === "PENDING") e.pending += 1;
  }
  const perCluster = [...perClusterMap.values()].sort((a, b) =>
    (b.completed + b.failed + b.pending + b.running) - (a.completed + a.failed + a.pending + a.running),
  );

  // ---------- Resource hours per day (7d) ----------
  const dayHours = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (6 - i));
    return { day: `${d.getMonth() + 1}/${d.getDate()}`, gpu: 0, cpu: 0, epoch: d.getTime() };
  });
  for (const j of jobs7d) {
    if (j.status !== "COMPLETED" && j.status !== "FAILED" && j.status !== "CANCELLED") continue;
    const durSec = (j.updatedAt.getTime() - j.createdAt.getTime()) / 1000;
    if (durSec <= 0) continue;
    const { gpus, cpus } = parseJobGresCpus(j.script);
    // Bucket by the job's end date.
    const end = new Date(j.updatedAt);
    end.setHours(0, 0, 0, 0);
    const slot = dayHours.find((d) => d.epoch === end.getTime());
    if (slot) {
      slot.gpu += (gpus * durSec) / 3600;
      slot.cpu += (cpus * durSec) / 3600;
    }
  }

  // ---------- Activity heatmap (60d) ----------
  const heatmapDays = Array.from({ length: 60 }, (_, i) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (59 - i));
    return { date: d.toISOString().slice(0, 10), epoch: d.getTime(), count: 0 };
  });
  for (const j of createdAt60d) {
    const d = new Date(j.createdAt);
    d.setHours(0, 0, 0, 0);
    const slot = heatmapDays.find((x) => x.epoch === d.getTime());
    if (slot) slot.count += 1;
  }

  // ---------- Live queue snapshot (per cluster) ----------
  const queueByCluster = new Map<string, { clusterId: string; clusterName: string; pending: number; running: number; oldestSubmitMs: number | null }>();
  for (const j of liveJobs) {
    const key = j.cluster?.id ?? "?";
    if (!queueByCluster.has(key)) {
      queueByCluster.set(key, { clusterId: key, clusterName: j.cluster?.name ?? "?", pending: 0, running: 0, oldestSubmitMs: null });
    }
    const e = queueByCluster.get(key)!;
    if (j.status === "PENDING") e.pending += 1;
    else if (j.status === "RUNNING") e.running += 1;
    const ms = j.createdAt.getTime();
    if (e.oldestSubmitMs === null || ms < e.oldestSubmitMs) e.oldestSubmitMs = ms;
  }
  const liveQueue = [...queueByCluster.values()];

  // ---------- Top failing job names (24h) ----------
  const failingMap = new Map<string, { name: string; count: number; lastExit: number | null; lastId: string; clusterId: string }>();
  for (const j of jobs24h) {
    if (j.status !== "FAILED" && j.status !== "CANCELLED") continue;
    const name = parseJobName(j.script, j.id);
    if (!failingMap.has(name)) {
      failingMap.set(name, { name, count: 0, lastExit: j.exitCode, lastId: j.id, clusterId: j.cluster?.id ?? "" });
    }
    const e = failingMap.get(name)!;
    e.count += 1;
    if (j.updatedAt.getTime() >= (jobs24h.find((x) => x.id === e.lastId)?.updatedAt.getTime() ?? 0)) {
      e.lastId = j.id;
      e.lastExit = j.exitCode;
      e.clusterId = j.cluster?.id ?? "";
    }
  }
  const topFailing = [...failingMap.values()].sort((a, b) => b.count - a.count).slice(0, 6);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome back, {session.user.name ?? session.user.email}
        </p>
      </div>

      {/* ---------- KPI stat row ---------- */}
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Running now" value={running} tone={running > 0 ? "positive" : "muted"} />
        <StatCard label="Queued" value={queued} tone={queued > 0 ? "warning" : "muted"} />
        <StatCard label="Jobs (24h)" value={jobs24h.length} />
        <StatCard
          label="Success rate (24h)"
          value={successRate === null ? "—" : `${successRate}%`}
          tone={successRate === null ? "muted" : successRate >= 80 ? "positive" : successRate >= 50 ? "warning" : "negative"}
          sub={terminal24h.length > 0 ? `${completed24h}/${terminal24h.length} finished` : undefined}
        />
        <StatCard
          label="Median duration (24h)"
          value={medianDuration === null ? "—" : fmtDuration(Math.round(medianDuration))}
          sub={durations24h.length > 0 ? `${durations24h.length} samples` : undefined}
        />
        <StatCard
          label="GPU-hours (7d)"
          value={gpuHours7d > 0 ? gpuHours7d.toFixed(1) : "0"}
          sub={`${cpuHours7d.toFixed(0)} CPU-hours`}
        />
      </div>

      {/* ---------- 24h trend + status donut ---------- */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Last 24 hours</CardTitle>
          </CardHeader>
          <CardContent>
            <JobsLast24hChart data={buckets} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Status breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <JobsStatusDonut
              data={[
                { name: "Running", value: last24Totals.running, color: "var(--chart-2)" },
                { name: "Completed", value: last24Totals.completed, color: "var(--chart-3)" },
                { name: "Failed", value: last24Totals.failed, color: "var(--destructive)" },
              ]}
              total={last24Totals.running + last24Totals.completed + last24Totals.failed}
            />
          </CardContent>
        </Card>
      </div>

      {/* ---------- Duration histogram + per-cluster split ---------- */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Duration (24h, finished)</CardTitle>
          </CardHeader>
          <CardContent>
            <DurationHistogram data={durationBuckets.map(({ label, count }) => ({ label, count }))} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">By cluster (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            {perCluster.length === 0 ? (
              <p className="text-sm text-muted-foreground">No jobs submitted in the last 24h.</p>
            ) : (
              <PerClusterSplit data={perCluster} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------- Resource hours + activity heatmap ---------- */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Compute consumed (7d)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResourceHours7d data={dayHours.map(({ day, gpu, cpu }) => ({ day, gpu: +gpu.toFixed(2), cpu: +cpu.toFixed(2) }))} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Activity (60d)</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityHeatmap data={heatmapDays.map(({ date, count }) => ({ date, count }))} />
          </CardContent>
        </Card>
      </div>

      {/* ---------- Live queue + Top failing ---------- */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Live queue</CardTitle>
          </CardHeader>
          <CardContent>
            {liveQueue.length === 0 ? (
              <p className="text-sm text-muted-foreground">No running or pending jobs.</p>
            ) : (
              <ul className="space-y-2">
                {liveQueue.map((q) => (
                  <li key={q.clusterId} className="flex items-center justify-between gap-2 text-sm">
                    <Link href={`/clusters/${q.clusterId}/jobs`}
                      className="font-mono font-medium hover:underline truncate">
                      {q.clusterName}
                    </Link>
                    <span className="flex items-center gap-2 font-mono text-xs">
                      {q.running > 0 && <span className="text-chart-2">{q.running} running</span>}
                      {q.pending > 0 && <span className="text-amber-600 dark:text-amber-400">{q.pending} pending</span>}
                      {q.oldestSubmitMs && (
                        <span className="text-muted-foreground">
                          oldest {fmtDuration(Math.round((now.getTime() - q.oldestSubmitMs) / 1000))}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Top failures (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            {topFailing.length === 0 ? (
              <p className="text-sm text-muted-foreground">No failed or cancelled jobs in the last 24h. 🎉</p>
            ) : (
              <ul className="space-y-2">
                {topFailing.map((f) => (
                  <li key={f.name} className="flex items-center justify-between gap-2 text-sm">
                    <Link href={f.clusterId ? `/clusters/${f.clusterId}/jobs/${f.lastId}` : "#"}
                      className="font-mono truncate hover:underline">
                      {f.name}
                    </Link>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">×{f.count}</span>
                      {f.lastExit !== null && <span className="font-mono">exit {f.lastExit}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------- Recent jobs ---------- */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <JobTable
            jobs={recentJobs.map((j) => ({
              ...j,
              createdAt: j.createdAt.toISOString(),
            }))}
            showCluster
          />
        </CardContent>
      </Card>
    </div>
  );
}
