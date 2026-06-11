/**
 * GET /api/reports/combined — one daily report across BOTH platforms.
 *
 * Pure composition, no direct DB access:
 *   1. Calls this app's own /api/reports (forwarding the caller's session
 *      cookie, so scoping and filters behave identically) for the Slurm half.
 *   2. Calls GPUPlatform's job-history API — GET /v1/history/{kind} for
 *      kind ∈ {benchmarks, training, compute, inference, proxy} — and
 *      buckets the records into the same calendar days client-side.
 *
 * Accepts the same query params as /api/reports (from, to, tz, clusterId,
 * partitions, statuses, filterUserId); from/to/tz also bound the
 * GPUPlatform history window.
 *
 * Every job/record row carries a `description` key. Slurm jobs read it from
 * Job.description (always null today — nothing populates it yet); GPUPlatform
 * records have no such field yet so it is null there too. The key exists now
 * so consumers can rely on the shape.
 *
 * GPUPlatform connection is configured via env:
 *   GPUPLATFORM_URL      gateway base URL (no trailing slash)
 *   GPUPLATFORM_API_KEY  an ADMIN sgpu_… API key (the history API is
 *                        admin-gated — it returns every user's records)
 * When unset/unreachable, `gpuplatform` is null per-day and `notes` says
 * why — the Slurm half of the report still works.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { parseLocalMidnight, toLocalDateStr } from "@/lib/report-utils";

interface SlurmReport {
  period: { from: string; to: string };
  summary: Record<string, unknown>;
  dailyJobHistory: Array<{
    date: string;
    dayLabel: string;
    completed: number;
    failed: number;
    cancelled: number;
    gpuHours: number;
    cpuHours: number;
    jobs: Array<Record<string, unknown>>;
  }>;
}

// GPUPlatform /v1/history/{kind} envelope (history_api.py JobRecord).
interface GpJobRecord {
  kind: string;
  id: string;
  name: string | null;
  user: string;
  owner_id: number | null;
  status: string;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  error_text: string | null;
  detail: Record<string, unknown>;
}

interface GpHistoryPage {
  kind: string;
  count: number;
  has_more: boolean;
  jobs: GpJobRecord[];
}

const GP_KINDS = ["benchmarks", "training", "compute", "inference", "proxy"] as const;
const GP_PAGE_LIMIT = 1000; // history API max page size
const GP_MAX_PAGES = 5;     // per kind — bounds worst-case payload/time

async function fetchGpKind(
  base: string, key: string, kind: string, since: string, until: string,
): Promise<{ records: GpJobRecord[]; truncated: boolean } | { error: string }> {
  const records: GpJobRecord[] = [];
  for (let page = 0; page < GP_MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      since, until, order: "asc",
      limit: String(GP_PAGE_LIMIT), offset: String(page * GP_PAGE_LIMIT),
    });
    let res: Response;
    try {
      res = await fetch(`${base}/v1/history/${kind}?${qs}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
    } catch (e) {
      return { error: `${kind}: ${e instanceof Error ? e.message : "fetch failed"}` };
    }
    if (!res.ok) return { error: `${kind}: HTTP ${res.status}` };
    const body = (await res.json()) as GpHistoryPage;
    records.push(...body.jobs);
    if (!body.has_more) return { records, truncated: false };
  }
  return { records, truncated: true };
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const tzParam = searchParams.get("tz") ?? "UTC";
  let tz = "UTC";
  try { Intl.DateTimeFormat(undefined, { timeZone: tzParam }); tz = tzParam; } catch { /* keep UTC */ }

  // Same window semantics as /api/reports: from/to are local dates in `tz`.
  const now = new Date();
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const since = fromParam
    ? parseLocalMidnight(fromParam, tz)
    : new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const until = toParam
    ? new Date(parseLocalMidnight(toParam, tz).getTime() + 86400 * 1000)
    : now;

  const gpBase = process.env.GPUPLATFORM_URL?.replace(/\/+$/, "");
  const gpKey = process.env.GPUPLATFORM_API_KEY;

  // Slurm report (own API, caller's cookie) + all GPUPlatform kinds, concurrently.
  const slurmUrl = new URL("/api/reports", request.nextUrl.origin);
  searchParams.forEach((v, k) => slurmUrl.searchParams.set(k, v));

  const [slurmRes, ...gpResults] = await Promise.all([
    fetch(slurmUrl, {
      headers: { cookie: request.headers.get("cookie") ?? "" },
      cache: "no-store",
    }),
    ...(gpBase && gpKey
      ? GP_KINDS.map((k) => fetchGpKind(gpBase, gpKey, k, since.toISOString(), until.toISOString()))
      : []),
  ]);

  if (!slurmRes.ok) {
    return NextResponse.json(
      { error: `Slurm report failed: HTTP ${slurmRes.status}` },
      { status: 502 },
    );
  }
  const slurm = (await slurmRes.json()) as SlurmReport;

  const notes: string[] = [];
  const gpConfigured = Boolean(gpBase && gpKey);
  if (!gpConfigured) {
    notes.push("GPUPlatform not configured (set GPUPLATFORM_URL and GPUPLATFORM_API_KEY)");
  }

  // Collect GPUPlatform records; one kind failing doesn't sink the others.
  const gpRecords: GpJobRecord[] = [];
  let gpAnyOk = false;
  gpResults.forEach((r, i) => {
    if ("error" in r) {
      notes.push(`GPUPlatform ${r.error}`);
      return;
    }
    gpAnyOk = true;
    gpRecords.push(...r.records);
    if (r.truncated) {
      notes.push(`GPUPlatform ${GP_KINDS[i]}: more than ${GP_PAGE_LIMIT * GP_MAX_PAGES} records in range — list truncated (counts reflect fetched rows only)`);
    }
  });

  // Bucket records into calendar days in the client's timezone.
  const gpByDay = new Map<string, GpJobRecord[]>();
  for (const rec of gpRecords) {
    if (!rec.created_at) continue;
    const day = toLocalDateStr(new Date(rec.created_at), tz);
    (gpByDay.get(day) ?? gpByDay.set(day, []).get(day)!).push(rec);
  }

  const mapRecord = (r: GpJobRecord) => ({
    kind: r.kind,
    id: r.id,
    name: r.name,
    description: null as string | null,
    user: r.user,
    status: r.status,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationS: r.duration_s,
    errorText: r.error_text,
    detail: r.detail,
  });

  const summarize = (recs: GpJobRecord[]) => {
    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const r of recs) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    }
    return {
      totalRecords: recs.length,
      // "requests" = the two high-volume request-shaped kinds.
      totalRequests: (byKind["inference"] ?? 0) + (byKind["proxy"] ?? 0),
      byKind,
      byStatus,
    };
  };

  // Slurm's dailyJobHistory already spans every day in the range — use it as
  // the spine; GPUPlatform-only days (shouldn't happen with the same window)
  // are appended for completeness.
  const seen = new Set<string>();
  const days = slurm.dailyJobHistory.map((day) => {
    seen.add(day.date);
    const recs = gpByDay.get(day.date) ?? [];
    return {
      date: day.date,
      dayLabel: day.dayLabel,
      slurm: {
        totalJobs: day.jobs.length,
        completed: day.completed,
        failed: day.failed,
        cancelled: day.cancelled,
        gpuHours: day.gpuHours,
        cpuHours: day.cpuHours,
        jobs: day.jobs, // each row already carries `description` (null for now)
      },
      gpuplatform: gpConfigured && gpAnyOk
        ? { ...summarize(recs), records: recs.map(mapRecord) }
        : null,
    };
  });
  for (const [date, recs] of gpByDay) {
    if (seen.has(date)) continue;
    days.push({
      date,
      dayLabel: date,
      slurm: { totalJobs: 0, completed: 0, failed: 0, cancelled: 0, gpuHours: 0, cpuHours: 0, jobs: [] },
      gpuplatform: { ...summarize(recs), records: recs.map(mapRecord) },
    });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));

  return NextResponse.json({
    period: slurm.period,
    tz,
    totals: {
      slurm: slurm.summary,
      gpuplatform: gpConfigured && gpAnyOk ? summarize(gpRecords) : null,
    },
    days,
    notes,
  });
}
