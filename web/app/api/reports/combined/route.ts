/**
 * GET /api/reports/combined — one daily report across BOTH platforms.
 *
 * Pure composition, no direct DB access: it calls this app's own
 * /api/reports (forwarding the caller's session cookie, so scoping and
 * filters behave identically) and GPUPlatform's /v1/usage/report, then
 * zips the two by calendar day. Accepts the same query params as
 * /api/reports (from, to, tz, clusterId, partitions, statuses,
 * filterUserId) — all are passed through to the Slurm report; from/to/tz
 * are also passed to GPUPlatform.
 *
 * Every job/request row carries a `description` key. Slurm jobs read it
 * from Job.description (always null today — nothing populates it yet);
 * GPUPlatform requests have no such field yet so it is null there too.
 * The key exists now so consumers can rely on the shape.
 *
 * GPUPlatform connection is configured via env:
 *   GPUPLATFORM_URL      e.g. https://gateway.example.com (no trailing slash)
 *   GPUPLATFORM_API_KEY  an sgpu_… API key
 * When unset/unreachable, `gpuplatform` is null per-day and `notes` says
 * why — the Slurm half of the report still works.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

interface SlurmReport {
  period: { from: string; to: string };
  clusterName: string;
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

interface GpuPlatformReport {
  summary: {
    total_requests: number;
    completed: number;
    server_error: number;
    client_cancelled: number;
    pending: number;
    tokens_in: number;
    tokens_out: number;
    tokens_total: number;
    distinct_models: number;
    distinct_apps: number;
    distinct_users: number;
  };
  daily: Array<{
    date: string;
    requests: number;
    completed: number;
    server_error: number;
    client_cancelled: number;
    tokens_total: number;
    jobs: Array<{
      request_id: string;
      app_id: string;
      model: string;
      endpoint: string;
      username: string;
      status: string;
      outcome: string;
      start_time: string;
      end_time: string;
      elapsed_label: string;
    }>;
  }>;
}

async function fetchGpuPlatform(
  from: string | null, to: string | null, tz: string,
): Promise<{ report: GpuPlatformReport | null; note: string | null }> {
  const base = process.env.GPUPLATFORM_URL?.replace(/\/+$/, "");
  const key = process.env.GPUPLATFORM_API_KEY;
  if (!base || !key) {
    return { report: null, note: "GPUPlatform not configured (set GPUPLATFORM_URL and GPUPLATFORM_API_KEY)" };
  }
  const qs = new URLSearchParams({ tz, bucket: "day" });
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  try {
    const res = await fetch(`${base}/v1/usage/report?${qs}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok) return { report: null, note: `GPUPlatform returned HTTP ${res.status}` };
    return { report: (await res.json()) as GpuPlatformReport, note: null };
  } catch (e) {
    return { report: null, note: `GPUPlatform unreachable: ${e instanceof Error ? e.message : "unknown error"}` };
  }
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const tz = searchParams.get("tz") ?? "UTC";

  // Call our own /api/reports with the caller's cookie — identical scoping.
  const slurmUrl = new URL("/api/reports", request.nextUrl.origin);
  searchParams.forEach((v, k) => slurmUrl.searchParams.set(k, v));

  const [slurmRes, gp] = await Promise.all([
    fetch(slurmUrl, {
      headers: { cookie: request.headers.get("cookie") ?? "" },
      cache: "no-store",
    }),
    fetchGpuPlatform(searchParams.get("from"), searchParams.get("to"), tz),
  ]);

  if (!slurmRes.ok) {
    return NextResponse.json(
      { error: `Slurm report failed: HTTP ${slurmRes.status}` },
      { status: 502 },
    );
  }
  const slurm = (await slurmRes.json()) as SlurmReport;
  const gpDayMap = new Map((gp.report?.daily ?? []).map((d) => [d.date, d]));

  // The Slurm report already spans every calendar day in the range, so use
  // it as the spine; GPUPlatform days outside it (shouldn't happen with the
  // same from/to) are appended at the end for completeness.
  const seen = new Set<string>();
  const days = slurm.dailyJobHistory.map((day) => {
    seen.add(day.date);
    const g = gpDayMap.get(day.date);
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
      gpuplatform: g
        ? {
            totalRequests: g.requests,
            completed: g.completed,
            serverError: g.server_error,
            clientCancelled: g.client_cancelled,
            tokensTotal: g.tokens_total,
            requests: g.jobs.map((r) => ({
              requestId: r.request_id,
              appId: r.app_id,
              model: r.model,
              endpoint: r.endpoint,
              description: null as string | null,
              username: r.username,
              status: r.status,
              outcome: r.outcome,
              startTime: r.start_time,
              endTime: r.end_time,
              elapsedLabel: r.elapsed_label,
            })),
          }
        : gp.report
        ? { totalRequests: 0, completed: 0, serverError: 0, clientCancelled: 0, tokensTotal: 0, requests: [] }
        : null,
    };
  });
  for (const [date, g] of gpDayMap) {
    if (seen.has(date)) continue;
    days.push({
      date,
      dayLabel: date,
      slurm: { totalJobs: 0, completed: 0, failed: 0, cancelled: 0, gpuHours: 0, cpuHours: 0, jobs: [] },
      gpuplatform: {
        totalRequests: g.requests,
        completed: g.completed,
        serverError: g.server_error,
        clientCancelled: g.client_cancelled,
        tokensTotal: g.tokens_total,
        requests: g.jobs.map((r) => ({
          requestId: r.request_id, appId: r.app_id, model: r.model,
          endpoint: r.endpoint, description: null as string | null,
          username: r.username, status: r.status, outcome: r.outcome,
          startTime: r.start_time, endTime: r.end_time, elapsedLabel: r.elapsed_label,
        })),
      },
    });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));

  return NextResponse.json({
    period: slurm.period,
    tz,
    totals: {
      slurm: slurm.summary,
      gpuplatform: gp.report
        ? {
            totalRequests: gp.report.summary.total_requests,
            completed: gp.report.summary.completed,
            serverError: gp.report.summary.server_error,
            clientCancelled: gp.report.summary.client_cancelled,
            tokensIn: gp.report.summary.tokens_in,
            tokensOut: gp.report.summary.tokens_out,
            tokensTotal: gp.report.summary.tokens_total,
            distinctModels: gp.report.summary.distinct_models,
            distinctApps: gp.report.summary.distinct_apps,
            distinctUsers: gp.report.summary.distinct_users,
          }
        : null,
    },
    days,
    notes: gp.note ? [gp.note] : [],
  });
}
