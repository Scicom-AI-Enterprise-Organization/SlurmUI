import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// ── Timezone helpers (pure Intl, no external deps) ────────────────────────

// Convert "YYYY-MM-DD" to the UTC instant representing midnight in `tz`.
function parseLocalMidnight(dateStr: string, tz: string): Date {
  const [y, mo, d] = dateStr.split("-").map(Number);
  // Probe at UTC noon — avoids the rare "24:00" display edge case at midnight.
  const probe = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hour12: false,
  }).formatToParts(probe);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
  const lh = get("hour") === 24 ? 0 : get("hour");
  const localNoonAsUTC = Date.UTC(get("year"), get("month") - 1, get("day"), lh, get("minute"), get("second"));
  const offsetMs = localNoonAsUTC - probe.getTime();
  return new Date(Date.UTC(y, mo - 1, d) - offsetMs);
}

// Format a Date as "YYYY-MM-DD" in `tz`.
function toLocalDateStr(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

// Format a Date as "HH:MM" (24-hour) in `tz`.
function fmtTimeInTZ(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  return `${parts.find((p) => p.type === "hour")!.value}:${parts.find((p) => p.type === "minute")!.value}`;
}

// Return every "YYYY-MM-DD" calendar string from fromStr to toStr (inclusive).
function dateRangeStrings(fromStr: string, toStr: string): string[] {
  const dates: string[] = [];
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  let y = fy, m = fm, d = fd;
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i < 400; i++) {
    const s = `${y}-${pad(m)}-${pad(d)}`;
    dates.push(s);
    if (s >= toStr) break;
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    y = next.getUTCFullYear(); m = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  return dates;
}

// ── Job-script parsers ────────────────────────────────────────────────────

function parseJobGresCpus(script: string): { gpus: number; cpus: number } {
  const gpuPatterns: RegExp[] = [
    /#SBATCH\s+--gres=gpu(?::[^:\s]+)?:(\d+)/,
    /#SBATCH\s+--gpus[=\s]+(?:[a-z0-9_-]+:)?(\d+)/i,
    /#SBATCH\s+-G[=\s]+(?:[a-z0-9_-]+:)?(\d+)/i,
    /#SBATCH\s+--gpus-per-task[=\s]+(?:[a-z0-9_-]+:)?(\d+)/i,
    /#SBATCH\s+--gpus-per-node[=\s]+(?:[a-z0-9_-]+:)?(\d+)/i,
  ];
  let gpus = 0;
  for (const re of gpuPatterns) {
    const m = script.match(re);
    if (m) gpus = Math.max(gpus, parseInt(m[1], 10) || 0);
  }
  const cpt = script.match(/#SBATCH\s+(?:--cpus-per-task|-c)[=\s]+(\d+)/);
  return { gpus, cpus: cpt ? parseInt(cpt[1], 10) || 1 : 1 };
}

function parseJobName(script: string, id: string): string {
  const m = script.match(/#SBATCH\s+(?:--job-name|-J)[=\s]+(\S+)/);
  return m ? m[1] : `job-${id.slice(0, 8)}`;
}

// ── Formatting helpers ────────────────────────────────────────────────────

function fmtElapsed(sec: number): string {
  if (sec <= 0) return "00:00:00";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const hms = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return d > 0 ? `${d}-${hms}` : hms;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const isAdmin = (session.user as { role?: string }).role === "ADMIN";
  const scope = isAdmin ? {} : { userId };

  const { searchParams } = request.nextUrl;
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const clusterIdParam = searchParams.get("clusterId") || undefined;
  const partitionsParam = searchParams.get("partitions"); // comma-separated
  const statusesParam = searchParams.get("statuses");     // comma-separated
  const filterUserIdParam = searchParams.get("filterUserId") || undefined;

  // Validate the client timezone, fall back to UTC if unrecognised.
  const tzParam = searchParams.get("tz") ?? "UTC";
  let tz = "UTC";
  try { Intl.DateTimeFormat(undefined, { timeZone: tzParam }); tz = tzParam; } catch { /* keep UTC */ }

  const now = new Date();
  const from = fromParam
    ? parseLocalMidnight(fromParam, tz)
    : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  // End of day = 1 ms before the next local midnight.
  const to = toParam
    ? new Date(parseLocalMidnight(toParam, tz).getTime() + 86400 * 1000 - 1)
    : now;

  const clusterFilter = clusterIdParam ? { clusterId: clusterIdParam } : {};
  const partitionFilter =
    partitionsParam ? { partition: { in: partitionsParam.split(",") } } : {};
  const statusFilter =
    statusesParam ? { status: { in: statusesParam.split(",") as ("PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED")[] } } : {};
  // Admins can optionally filter to a specific user; non-admins always see only their own.
  const userScopeFilter = !isAdmin
    ? { userId }
    : filterUserIdParam
    ? { userId: filterUserIdParam }
    : {};

  // Jobs in the date range + currently running jobs
  const [jobs, runningJobs, clusters] = await prisma.$transaction([
    prisma.job.findMany({
      where: {
        ...userScopeFilter,
        ...clusterFilter,
        ...partitionFilter,
        ...statusFilter,
        createdAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        slurmJobId: true,
        name: true,
        script: true,
        status: true,
        exitCode: true,
        createdAt: true,
        updatedAt: true,
        userId: true,
        cluster: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.job.findMany({
      where: {
        ...userScopeFilter,
        ...clusterFilter,
        ...partitionFilter,
        status: { in: ["RUNNING", "PENDING"] },
      },
      select: {
        id: true,
        slurmJobId: true,
        name: true,
        script: true,
        status: true,
        createdAt: true,
        userId: true,
        cluster: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
    prisma.cluster.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // Resolve users
  const allUserIds = [
    ...new Set([...jobs.map((j) => j.userId), ...runningJobs.map((j) => j.userId)]),
  ];
  const users = await prisma.user.findMany({
    where: { id: { in: allUserIds } },
    select: { id: true, name: true, unixUsername: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  // Cluster label for the report title
  const clusterNamesInData = [...new Set(jobs.map((j) => j.cluster?.name).filter(Boolean))];
  const clusterName = clusterIdParam
    ? (clusters.find((c) => c.id === clusterIdParam)?.name ?? "Unknown")
    : clusterNamesInData.length === 1
    ? clusterNamesInData[0]!
    : "All clusters";

  // Terminal jobs
  const terminal = jobs.filter(
    (j) => j.status === "COMPLETED" || j.status === "FAILED" || j.status === "CANCELLED",
  );
  const completed = terminal.filter((j) => j.status === "COMPLETED").length;
  const failed = terminal.filter((j) => j.status === "FAILED").length;
  const cancelled = terminal.filter((j) => j.status === "CANCELLED").length;
  const successRate =
    terminal.length > 0 ? Math.round((completed / terminal.length) * 100) : null;

  const durations = terminal
    .map((j) => (j.updatedAt.getTime() - j.createdAt.getTime()) / 1000)
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
  const medianDurationSec =
    durations.length > 0 ? durations[Math.floor(durations.length / 2)] : null;
  const avgDurationSec =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

  let gpuHours = 0;
  let cpuHours = 0;
  for (const j of terminal) {
    const durSec = (j.updatedAt.getTime() - j.createdAt.getTime()) / 1000;
    if (durSec <= 0) continue;
    const { gpus, cpus } = parseJobGresCpus(j.script);
    gpuHours += (gpus * durSec) / 3600;
    cpuHours += (cpus * durSec) / 3600;
  }

  // Top users by job count
  const userJobCount = new Map<string, number>();
  for (const j of jobs) {
    userJobCount.set(j.userId, (userJobCount.get(j.userId) ?? 0) + 1);
  }
  const topUsers = [...userJobCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([uid, count]) => {
      const u = userMap.get(uid);
      return { unixUsername: u?.unixUsername ?? null, name: u?.name ?? null, jobCount: count };
    });

  // Currently running / pending jobs
  const currentlyRunning = runningJobs.map((j) => {
    const u = userMap.get(j.userId);
    const elapsedSec = Math.round((now.getTime() - j.createdAt.getTime()) / 1000);
    const startDate = j.createdAt;
    const startLabel =
      startDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz }) +
      ", " +
      fmtTimeInTZ(startDate, tz);
    return {
      slurmJobId: j.slurmJobId,
      jobName: j.name ?? parseJobName(j.script, j.id),
      unixUsername: u?.unixUsername ?? null,
      state: j.status,
      startedAt: startLabel,
      elapsedLabel: fmtElapsed(elapsedSec),
    };
  });

  // vLLM serving jobs (name contains "vllm")
  const vllmJobs = jobs
    .filter((j) => (j.name ?? parseJobName(j.script, j.id)).toLowerCase().includes("vllm"))
    .map((j) => {
      const u = userMap.get(j.userId);
      const durSec = Math.max(0, (j.updatedAt.getTime() - j.createdAt.getTime()) / 1000);
      return {
        slurmJobId: j.slurmJobId,
        jobName: j.name ?? parseJobName(j.script, j.id),
        unixUsername: u?.unixUsername ?? null,
        state: j.status,
        elapsedLabel: fmtElapsed(durSec),
      };
    });

  // Per-day breakdown: one entry per calendar day in the range (in the client's TZ).
  const fromDateStr = fromParam ?? toLocalDateStr(from, tz);
  const toDateStr   = toParam   ?? toLocalDateStr(now, tz);
  const dayStrings  = dateRangeStrings(fromDateStr, toDateStr);

  const dailyJobHistory: Array<{
    date: string;
    dayLabel: string;
    completed: number;
    failed: number;
    cancelled: number;
    gpuHours: number;
    cpuHours: number;
    jobs: Array<{
      slurmJobId: number | null;
      jobName: string;
      unixUsername: string | null;
      state: string;
      startTime: string;
      endTime: string;
      elapsedLabel: string;
    }>;
  }> = [];

  for (const dateStr of dayStrings) {
    // Match jobs whose creation timestamp falls on this calendar day in the client TZ.
    const dayJobs = jobs.filter((j) => toLocalDateStr(j.createdAt, tz) === dateStr);

    let dayGpu = 0;
    let dayCpu = 0;
    for (const j of dayJobs) {
      if (j.status === "COMPLETED" || j.status === "FAILED" || j.status === "CANCELLED") {
        const durSec = (j.updatedAt.getTime() - j.createdAt.getTime()) / 1000;
        if (durSec > 0) {
          const { gpus, cpus } = parseJobGresCpus(j.script);
          dayGpu += (gpus * durSec) / 3600;
          dayCpu += (cpus * durSec) / 3600;
        }
      }
    }

    const dayMidnight = parseLocalMidnight(dateStr, tz);
    dailyJobHistory.push({
      date: dateStr,
      dayLabel: dayMidnight.toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz,
      }),
      completed: dayJobs.filter((j) => j.status === "COMPLETED").length,
      failed: dayJobs.filter((j) => j.status === "FAILED").length,
      cancelled: dayJobs.filter((j) => j.status === "CANCELLED").length,
      gpuHours: +dayGpu.toFixed(2),
      cpuHours: +dayCpu.toFixed(2),
      jobs: dayJobs.map((j) => {
        const u = userMap.get(j.userId);
        const isTerminal =
          j.status === "COMPLETED" || j.status === "FAILED" || j.status === "CANCELLED";
        const durSec = Math.max(0, (j.updatedAt.getTime() - j.createdAt.getTime()) / 1000);
        return {
          slurmJobId: j.slurmJobId,
          jobName: j.name ?? parseJobName(j.script, j.id),
          unixUsername: u?.unixUsername ?? null,
          state: j.status,
          startTime: fmtTimeInTZ(j.createdAt, tz),
          endTime: isTerminal ? fmtTimeInTZ(j.updatedAt, tz) : "",
          elapsedLabel: fmtElapsed(durSec),
        };
      }),
    });
  }

  // Per-cluster aggregates
  const clusterMap: Record<
    string,
    { clusterName: string; completed: number; failed: number; cancelled: number; gpuHours: number; cpuHours: number }
  > = {};
  for (const j of jobs) {
    const key = j.cluster?.id ?? "unknown";
    const name = j.cluster?.name ?? "Unknown";
    if (!clusterMap[key]) {
      clusterMap[key] = { clusterName: name, completed: 0, failed: 0, cancelled: 0, gpuHours: 0, cpuHours: 0 };
    }
    if (j.status === "COMPLETED") clusterMap[key].completed += 1;
    else if (j.status === "FAILED") clusterMap[key].failed += 1;
    else if (j.status === "CANCELLED") clusterMap[key].cancelled += 1;
    if (j.status === "COMPLETED" || j.status === "FAILED" || j.status === "CANCELLED") {
      const durSec = (j.updatedAt.getTime() - j.createdAt.getTime()) / 1000;
      if (durSec > 0) {
        const { gpus, cpus } = parseJobGresCpus(j.script);
        clusterMap[key].gpuHours += (gpus * durSec) / 3600;
        clusterMap[key].cpuHours += (cpus * durSec) / 3600;
      }
    }
  }

  return NextResponse.json({
    period: { from: from.toISOString(), to: to.toISOString() },
    clusterName,
    clusters: clusters.map((c) => ({ id: c.id, name: c.name })),
    summary: {
      totalJobs: jobs.length,
      completed,
      failed,
      cancelled,
      successRate,
      gpuHours: +gpuHours.toFixed(2),
      cpuHours: +cpuHours.toFixed(2),
      medianDurationSec: medianDurationSec !== null ? Math.round(medianDurationSec) : null,
      avgDurationSec,
    },
    topUsers,
    currentlyRunning,
    vllmJobs,
    dailyJobHistory,
    perCluster: Object.values(clusterMap)
      .sort((a, b) => b.completed + b.failed + b.cancelled - (a.completed + a.failed + a.cancelled))
      .map((c) => ({
        ...c,
        gpuHours: +c.gpuHours.toFixed(2),
        cpuHours: +c.cpuHours.toFixed(2),
      })),
  });
}
