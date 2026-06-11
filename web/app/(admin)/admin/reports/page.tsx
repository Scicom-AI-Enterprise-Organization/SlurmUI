"use client";

import { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  AreaChart, Area,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/dashboard/stat-card";
import { ChevronDown, ChevronRight, Printer, FileText, X } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

type TopUser = { unixUsername: string | null; name: string | null; jobCount: number };
type RunningJob = {
  slurmJobId: number | null; jobName: string; unixUsername: string | null;
  state: string; startedAt: string; elapsedLabel: string;
  partition: string; nodeList: string | null; gresDetail: string | null;
  cudaVisibleDevices: string | null;
};
type VllmJob = {
  slurmJobId: number | null; jobName: string; unixUsername: string | null;
  state: string; elapsedLabel: string;
};
type DayJob = {
  slurmJobId: number | null; jobName: string; unixUsername: string | null;
  state: string; startTime: string; endTime: string; elapsedLabel: string;
  partition: string; nodeList: string | null; gresDetail: string | null;
  cudaVisibleDevices: string | null;
};
// "gpu:a100:2(IDX:0,1)" → shown as-is; the IDX list is what the job sees as
// CUDA_VISIBLE_DEVICES. Falls back to the bare index list for older rows.
function fmtGpuAlloc(j: { gresDetail: string | null; cudaVisibleDevices: string | null }): string {
  if (j.gresDetail) return j.gresDetail;
  if (j.cudaVisibleDevices) return `CUDA ${j.cudaVisibleDevices}`;
  return "—";
}

type DayEntry = {
  date: string; dayLabel: string;
  completed: number; failed: number; cancelled: number;
  gpuHours: number; cpuHours: number;
  jobs: DayJob[];
};
type ClusterEntry = {
  clusterName: string;
  completed: number; failed: number; cancelled: number;
  gpuHours: number; cpuHours: number;
};
type ReportData = {
  period: { from: string; to: string };
  clusterName: string;
  clusters: { id: string; name: string }[];
  summary: {
    totalJobs: number; completed: number; failed: number; cancelled: number;
    successRate: number | null; gpuHours: number; cpuHours: number;
    medianDurationSec: number | null; avgDurationSec: number | null;
  };
  topUsers: TopUser[];
  currentlyRunning: RunningJob[];
  vllmJobs: VllmJob[];
  dailyJobHistory: DayEntry[];
  perCluster: ClusterEntry[];
};

type PromSeries = { metric: Record<string, string>; values: [number, string][] };
type PromData = {
  memUsed: PromSeries[];
  utilization: PromSeries[];
  temperature: PromSeries[];
  powerUsage: PromSeries[];
} | null;

type FilterOptions = {
  partitions: string[];
  partitionNodes: Record<string, string[]>;
  users: { id: string; name: string | null; unixUsername: string | null }[];
};

const ALL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED", "RUNNING", "PENDING"] as const;
type JobStatus = (typeof ALL_STATUSES)[number];

// ── Constants ─────────────────────────────────────────────────────────────

const GPU_COLORS = ["#4f9cf9", "#f97316", "#22c55e", "#a855f7", "#ec4899", "#06b6d4", "#eab308", "#ef4444"];

// Metric definitions per exporter family.
// nvidia_smi = utkuozdemir/nvidia_gpu_exporter binary (systemd)
// dcgm       = nvcr.io/nvidia/k8s/dcgm-exporter container
type MetricDef = { query: string; divisor: number; unit: string };
type MetricFamily = { memUsed: MetricDef; utilization: MetricDef; temperature: MetricDef; powerUsage: MetricDef };

const METRIC_FAMILIES: Record<"dcgm" | "nvidia_smi", MetricFamily> = {
  dcgm: {
    memUsed:     { query: "DCGM_FI_DEV_FB_USED",     divisor: 1024,        unit: " GiB" },
    utilization: { query: "DCGM_FI_DEV_GPU_UTIL",    divisor: 1,           unit: "%"    },
    temperature: { query: "DCGM_FI_DEV_GPU_TEMP",    divisor: 1,           unit: "°C"   },
    powerUsage:  { query: "DCGM_FI_DEV_POWER_USAGE", divisor: 1,           unit: " W"   },
  },
  nvidia_smi: {
    memUsed:     { query: "nvidia_smi_memory_used_bytes",     divisor: 1_073_741_824, unit: " GiB" },
    utilization: { query: "nvidia_smi_utilization_gpu_ratio", divisor: 0.01,          unit: "%"    },
    temperature: { query: "nvidia_smi_temperature_gpu",       divisor: 1,             unit: "°C"   },
    powerUsage:  { query: "nvidia_smi_power_draw_watts",      divisor: 1,             unit: " W"   },
  },
};

// ── Date helpers (all in the browser's local timezone) ────────────────────

function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function today() { return localIso(new Date()); }
function daysAgo(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n); return localIso(d);
}
function weekStart(offset = 0) {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day) + offset * 7);
  return localIso(d);
}
function monthStart(offset = 0) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
  return localIso(d);
}
function monthEnd(offset = 0) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset + 1); d.setDate(0);
  return localIso(d);
}
function capToday(s: string) { return s > today() ? today() : s; }

const DATE_PRESETS = [
  { label: "Today",      from: () => today(),       to: () => today() },
  { label: "Yesterday",  from: () => daysAgo(1),    to: () => daysAgo(1) },
  { label: "7d",         from: () => daysAgo(7),    to: () => today() },
  { label: "30d",        from: () => daysAgo(30),   to: () => today() },
  { label: "90d",        from: () => daysAgo(90),   to: () => today() },
  { label: "This week",  from: () => weekStart(0),  to: () => today() },
  { label: "Last week",  from: () => weekStart(-1), to: () => capToday(weekStart(0)) },
  { label: "This month", from: () => monthStart(0), to: () => today() },
  { label: "Last month", from: () => monthStart(-1),to: () => monthEnd(-1) },
];

// ── Misc helpers ──────────────────────────────────────────────────────────

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}
function fmtDate(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtWeekLabel(fromIso: string, toIso: string) {
  // fromIso/toIso are full ISO instants (server's .toISOString() of the client's
  // local-midnight boundaries). new Date() parses them directly; getDate() /
  // toLocaleDateString() then render in the browser's TZ = the correct local day.
  // Do NOT append "T00:00:00" here — that only applies to bare "YYYY-MM-DD" inputs.
  const from = new Date(fromIso);
  const to   = new Date(toIso);
  const toLabel = to.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return `${from.getDate()} to ${toLabel}`;
}

function summaryBullets(data: ReportData): string[] {
  const { summary, topUsers } = data;
  const bullets: string[] = [];
  if (!summary.totalJobs) { bullets.push("No jobs submitted in this period."); return bullets; }

  const running = summary.totalJobs - summary.completed - summary.failed - summary.cancelled;
  bullets.push(`${summary.totalJobs} job${summary.totalJobs !== 1 ? "s" : ""} submitted`);

  const bd: string[] = [];
  if (summary.completed) bd.push(`${summary.completed} completed`);
  if (summary.failed) bd.push(`${summary.failed} failed`);
  if (summary.cancelled) bd.push(`${summary.cancelled} cancelled`);
  if (running > 0) bd.push(`${running} running/pending`);
  if (bd.length) bullets.push(bd.join(", "));

  if (summary.successRate !== null)
    bullets.push(`Success rate: ${summary.successRate}% (${summary.completed} of ${summary.completed + summary.failed + summary.cancelled} finished)`);

  if (topUsers.length) {
    const names = topUsers.slice(0, 5).map((u) => u.unixUsername ?? u.name ?? "?").join(", ");
    bullets.push(`Active users: ${names}${topUsers.length > 5 ? ` and ${topUsers.length - 5} more` : ""}`);
  }
  if (summary.gpuHours > 0) bullets.push(`GPU-hours consumed: ${summary.gpuHours.toFixed(1)}`);
  if (summary.cpuHours > 0) bullets.push(`CPU-hours consumed: ${summary.cpuHours.toFixed(0)}`);
  return bullets;
}

// ── Prometheus helpers ────────────────────────────────────────────────────

function promStep(fromDate: string, toDate: string): number {
  const days = Math.ceil(
    (new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000,
  );
  if (days <= 1) return 60;   // 1-min for single day
  if (days <= 7) return 300;  // 5-min for weekly
  if (days <= 30) return 1800; // 30-min for monthly
  return 7200;                 // 2-h for 90d+
}

// Derive a stable, short, unique GPU label from a Prometheus series.
// Priority: index (nvidia_smi exporter) → gpu (dcgm exporter) → positional fallback.
function gpuLabel(s: PromSeries, fallbackIdx: number): string {
  const v = s.metric.index ?? s.metric.gpu;
  if (v !== undefined) return `GPU ${v}`;
  // uuid is a long string — shorten to last 4 hex chars for readability
  if (s.metric.uuid) return `GPU ${s.metric.uuid.slice(-4)}`;
  return `GPU ${fallbackIdx}`;
}

function buildDayChartData(series: PromSeries[], dateStr: string, divisor = 1) {
  // Local midnight boundaries so the chart starts at 00:00 in the browser's timezone.
  const dayStart = Math.floor(new Date(dateStr + "T00:00:00").getTime() / 1000);
  const dayEnd   = dayStart + 86400;

  const gpus = series
    .map((s, si) => ({
      id: gpuLabel(s, si),
      points: s.values
        .filter(([t]) => t >= dayStart && t < dayEnd)
        .map(([t, v]) => ({ ts: t, value: +(parseFloat(v) / divisor).toFixed(2) })),
    }))
    .filter((g) => g.points.length > 0);

  if (!gpus.length) return null;

  // Deduplicate series with the same label (shouldn't happen, but guard it)
  const seen = new Set<string>();
  const uniqueGpus = gpus.filter((g) => { if (seen.has(g.id)) return false; seen.add(g.id); return true; });

  const allTs = [...new Set(uniqueGpus.flatMap((g) => g.points.map((p) => p.ts)))].sort((a, b) => a - b);
  return allTs.map((ts) => {
    const row: Record<string, string | number> = {
      time: new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    };
    for (const g of uniqueGpus) {
      const pt = g.points.find((p) => p.ts === ts);
      if (pt) row[g.id] = pt.value;
    }
    return row;
  });
}

function gpuIds(series: PromSeries[]) {
  return series.map((s, i) => gpuLabel(s, i));
}

// ── GPUChart (shared screen + print) ─────────────────────────────────────

function GPUChart({
  chartData,
  ids,
  unit,
  height = 180,
}: {
  chartData: ReturnType<typeof buildDayChartData>;
  ids: string[];
  unit: string;
  height?: number;
}) {
  if (!chartData) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground italic">
        No Prometheus data for this day.
      </p>
    );
  }
  return (
    <div style={{ height, width: "100%" }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <XAxis dataKey="time" tick={{ fontSize: 9 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} width={34} unit={unit} />
          <Tooltip
            contentStyle={{ fontSize: 10, padding: "4px 8px" }}
            formatter={(v) => [`${v}${unit}`]}
          />
          <Legend wrapperStyle={{ fontSize: 9 }} layout="horizontal" />
          {ids.map((id, i) => (
            <Line key={id} dataKey={id} stroke={GPU_COLORS[i % GPU_COLORS.length]}
              dot={false} strokeWidth={1.5} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── MultiSelect ───────────────────────────────────────────────────────────

function MultiSelect({ label, options, selected, onChange }: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const display =
    selected.length === 0 ? "All" :
    selected.length === 1 ? selected[0] :
    `${selected.length} selected`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1 font-normal max-w-52">
          <span className="text-muted-foreground text-xs mr-0.5">{label}:</span>
          <span className="truncate">{display}</span>
          <ChevronDown className="ml-auto h-3 w-3 opacity-50 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto min-w-44">
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.value}
            checked={selected.includes(opt.value)}
            onCheckedChange={(c) =>
              onChange(c ? [...selected, opt.value] : selected.filter((v) => v !== opt.value))
            }
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}
        {selected.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs text-muted-foreground" onClick={() => onChange([])}>
              Clear selection
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Print-only table styles ───────────────────────────────────────────────

const TH: React.CSSProperties = {
  border: "1px solid #bbb", padding: "5px 10px", textAlign: "left",
  fontWeight: "bold", background: "#f0f0f0", fontSize: "13px",
};
const TD: React.CSSProperties = {
  border: "1px solid #bbb", padding: "5px 10px", fontSize: "13px", verticalAlign: "top",
};
const TABLE: React.CSSProperties = { width: "100%", borderCollapse: "collapse", marginBottom: "16px" };

function PMetaTable({ cluster, week, partitions, statuses, userName }: {
  cluster: string; week: string;
  partitions: string[]; statuses: string[]; userName?: string;
}) {
  return (
    <table style={{ ...TABLE, marginBottom: "28px", width: "auto", minWidth: "340px" }}>
      <tbody>
        <tr><td style={{ ...TH, width: "120px" }}>Cluster</td><td style={TD}>{cluster}</td></tr>
        <tr><td style={TH}>Period</td><td style={TD}>{week}</td></tr>
        {partitions.length > 0 && <tr><td style={TH}>Partition(s)</td><td style={TD}>{partitions.join(", ")}</td></tr>}
        {statuses.length > 0 && <tr><td style={TH}>Status filter</td><td style={TD}>{statuses.join(", ")}</td></tr>}
        {userName && <tr><td style={TH}>User</td><td style={TD}>{userName}</td></tr>}
      </tbody>
    </table>
  );
}

function PSummaryBullets({ bullets }: { bullets: string[] }) {
  return (
    <table style={TABLE}>
      <tbody>
        <tr>
          <td style={{ ...TH, width: "110px", verticalAlign: "top" }}>Summary</td>
          <td style={TD}>
            <ul style={{ margin: 0, paddingLeft: "16px" }}>
              {bullets.map((b, i) => <li key={i} style={{ marginBottom: "2px" }}>{b}</li>)}
            </ul>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function PUsersTable({ users }: { users: TopUser[] }) {
  if (!users.length) return <p style={{ color: "#666", fontSize: "13px", marginBottom: "16px" }}>No jobs submitted.</p>;
  return (
    <table style={TABLE}>
      <thead><tr><th style={TH}>Slurm user</th><th style={TH}>Name</th><th style={TH}>Jobs</th></tr></thead>
      <tbody>{users.map((u, i) => (
        <tr key={i}>
          <td style={{ ...TD, fontFamily: "monospace" }}>{u.unixUsername ?? "—"}</td>
          <td style={TD}>{u.name ?? "—"}</td>
          <td style={{ ...TD, textAlign: "right" }}>{u.jobCount}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function PRunningTable({ jobs }: { jobs: RunningJob[] }) {
  if (!jobs.length) return <p style={{ color: "#666", fontSize: "13px", marginBottom: "16px" }}>No jobs currently running.</p>;
  return (
    <table style={TABLE}>
      <thead><tr>
        <th style={TH}>Job</th><th style={TH}>User</th><th style={TH}>State</th>
        <th style={TH}>Node</th><th style={TH}>GPUs</th>
        <th style={TH}>Started</th><th style={TH}>Elapsed</th>
      </tr></thead>
      <tbody>{jobs.map((j, i) => (
        <tr key={i}>
          <td style={{ ...TD, fontFamily: "monospace" }}>{j.jobName}{j.slurmJobId !== null ? ` (ID ${j.slurmJobId})` : ""}</td>
          <td style={{ ...TD, fontFamily: "monospace" }}>{j.unixUsername ?? "—"}</td>
          <td style={TD}>{j.state}</td>
          <td style={{ ...TD, fontFamily: "monospace" }}>{j.nodeList ?? "—"}</td>
          <td style={{ ...TD, fontFamily: "monospace" }}>{fmtGpuAlloc(j)}</td>
          <td style={TD}>{j.startedAt}</td>
          <td style={{ ...TD, fontFamily: "monospace" }}>{j.elapsedLabel}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function PVllmTable({ jobs }: { jobs: VllmJob[] }) {
  return (
    <table style={TABLE}>
      <thead><tr>
        <th style={{ ...TH, width: "36px" }}>ID</th><th style={TH}>Model</th>
        <th style={TH}>User</th><th style={TH}>State</th><th style={TH}>Elapsed</th>
      </tr></thead>
      <tbody>{jobs.map((j, i) => (
        <tr key={i}>
          <td style={{ ...TD, fontFamily: "monospace" }}>{j.slurmJobId ?? "—"}</td>
          <td style={{ ...TD, fontFamily: "monospace" }}>{j.jobName}</td>
          <td style={{ ...TD, fontFamily: "monospace" }}>{j.unixUsername ?? "—"}</td>
          <td style={TD}>{j.state}</td>
          <td style={{ ...TD, fontFamily: "monospace" }}>{j.elapsedLabel}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function PJobHistoryTable({ jobs }: { jobs: DayJob[] }) {
  return (
    <table style={{ ...TABLE, fontSize: "12px" }}>
      <thead><tr>
        <th style={{ ...TH, fontSize: "12px", width: "36px" }}>ID</th>
        <th style={{ ...TH, fontSize: "12px" }}>JobName</th>
        <th style={{ ...TH, fontSize: "12px" }}>User</th>
        <th style={{ ...TH, fontSize: "12px" }}>State</th>
        <th style={{ ...TH, fontSize: "12px" }}>Partition</th>
        <th style={{ ...TH, fontSize: "12px" }}>Node</th>
        <th style={{ ...TH, fontSize: "12px" }}>GPUs</th>
        <th style={{ ...TH, fontSize: "12px", width: "46px" }}>Start</th>
        <th style={{ ...TH, fontSize: "12px", width: "46px" }}>End</th>
        <th style={{ ...TH, fontSize: "12px" }}>Elapsed</th>
      </tr></thead>
      <tbody>{jobs.map((j, i) => (
        <tr key={i}>
          <td style={{ ...TD, fontSize: "12px", fontFamily: "monospace" }}>{j.slurmJobId ?? "—"}</td>
          <td style={{ ...TD, fontSize: "12px", fontFamily: "monospace" }}>{j.jobName}</td>
          <td style={{ ...TD, fontSize: "12px", fontFamily: "monospace" }}>{j.unixUsername ?? "—"}</td>
          <td style={{ ...TD, fontSize: "12px" }}>{j.state}</td>
          <td style={{ ...TD, fontSize: "12px", fontFamily: "monospace" }}>{j.partition}</td>
          <td style={{ ...TD, fontSize: "12px", fontFamily: "monospace" }}>{j.nodeList ?? "—"}</td>
          <td style={{ ...TD, fontSize: "12px", fontFamily: "monospace" }}>{fmtGpuAlloc(j)}</td>
          <td style={{ ...TD, fontSize: "12px", fontFamily: "monospace" }}>{j.startTime}</td>
          <td style={{ ...TD, fontSize: "12px", fontFamily: "monospace" }}>{j.endTime || "—"}</td>
          <td style={{ ...TD, fontSize: "12px", fontFamily: "monospace" }}>{j.elapsedLabel}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

// Print-only GPU chart wrapper (no Tailwind classes — uses inline styles)
function PGPUChart({ label, chartData, ids, unit }: {
  label: string; chartData: ReturnType<typeof buildDayChartData>; ids: string[]; unit: string;
}) {
  return (
    <table style={{ ...TABLE, marginBottom: "8px" }}>
      <tbody>
        <tr>
          <td style={{ ...TH, width: "130px", verticalAlign: "top" }}>{label}</td>
          <td style={{ ...TD, padding: "4px" }}>
            {chartData ? (
              // Fixed pixel dimensions — ResponsiveContainer needs a rendered
              // parent width which is 0 in the hidden print:block context.
              <LineChart width={520} height={140} data={chartData}
                margin={{ top: 4, right: 8, left: 0, bottom: 20 }}>
                <XAxis dataKey="time" tick={{ fontSize: 8 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 8 }} axisLine={false} tickLine={false} width={34} unit={unit} />
                <Legend wrapperStyle={{ fontSize: 8 }} />
                {ids.map((id, i) => (
                  <Line key={id} dataKey={id} stroke={GPU_COLORS[i % GPU_COLORS.length]}
                    dot={false} strokeWidth={1} isAnimationActive={false} />
                ))}
              </LineChart>
            ) : (
              <span style={{ fontSize: "11px", color: "#888", fontStyle: "italic" }}>
                No Prometheus data available for this day.
              </span>
            )}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// ── DOCX export ───────────────────────────────────────────────────────────

// Render a line chart to a PNG using Canvas 2D — no external deps, works fully
// client-side. Returns a Uint8Array ready to embed in a docx ImageRun.
async function generateChartPng(
  chartData: Record<string, string | number>[] | null,
  ids: string[],
  unit: string,
): Promise<Uint8Array | null> {
  if (!chartData || chartData.length === 0 || ids.length === 0) return null;

  const W = 560, H = 175;
  const PAD = { top: 16, right: 16, bottom: 38, left: 54 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  const canvas = document.createElement("canvas");
  canvas.width = W * 2; canvas.height = H * 2; // @2x for sharpness
  const ctx = canvas.getContext("2d")!;
  ctx.scale(2, 2);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // Collect all numeric values for y-scale
  const allVals: number[] = [];
  for (const id of ids)
    for (const row of chartData)
      if (typeof row[id] === "number") allVals.push(row[id] as number);
  if (!allVals.length) return null;

  const yMax = Math.max(...allVals) * 1.1 || 1;
  const n = chartData.length;
  const px = (i: number) => PAD.left + (i / Math.max(n - 1, 1)) * cW;
  const py = (v: number) => PAD.top + cH - (v / yMax) * cH;

  // Grid + Y-axis labels
  ctx.font = "9px Arial";
  for (let g = 0; g <= 4; g++) {
    const v = yMax - (g / 4) * yMax;
    const y = PAD.top + (g / 4) * cH;
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
    ctx.fillStyle = "#9ca3af"; ctx.textAlign = "right";
    ctx.fillText(`${v < 10 ? v.toFixed(1) : Math.round(v)}${unit}`, PAD.left - 4, y + 3);
  }

  // X-axis labels
  const xStep = Math.max(1, Math.floor(n / 7));
  ctx.fillStyle = "#9ca3af"; ctx.font = "8px Arial"; ctx.textAlign = "center";
  for (let i = 0; i < n; i += xStep)
    ctx.fillText(String(chartData[i].time ?? ""), px(i), PAD.top + cH + 12);

  // Series lines
  for (let si = 0; si < ids.length; si++) {
    const id = ids[si];
    ctx.strokeStyle = GPU_COLORS[si % GPU_COLORS.length];
    ctx.lineWidth = 1.5; ctx.beginPath();
    let first = true;
    for (let i = 0; i < n; i++) {
      const v = chartData[i][id];
      if (typeof v !== "number") continue;
      first ? ctx.moveTo(px(i), py(v)) : ctx.lineTo(px(i), py(v));
      first = false;
    }
    ctx.stroke();
  }

  // Legend
  ctx.font = "8px Arial"; ctx.textAlign = "left";
  let lx = PAD.left;
  const legendY = H - 8;
  for (let si = 0; si < ids.length; si++) {
    if (lx + 90 > W) break;
    ctx.fillStyle = GPU_COLORS[si % GPU_COLORS.length];
    ctx.fillRect(lx, legendY - 4, 14, 3);
    ctx.fillStyle = "#374151";
    const label = ids[si];
    ctx.fillText(label, lx + 17, legendY);
    lx += 17 + ctx.measureText(label).width + 12;
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) { resolve(null); return; }
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
    }, "image/png");
  });
}

async function exportDocx(
  data: ReportData,
  weekLabel: string,
  bullets: string[],
  selectedPartitions: string[],
  selectedStatuses: string[],
  selectedUserName: string | undefined,
  promData: PromData,
  promMeta: MetricFamily,
) {
  // Dynamic import so docx isn't bundled unless needed
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    HeadingLevel, WidthType, AlignmentType, BorderStyle, ImageRun,
  } = await import("docx");

  function cell(text: string, bold = false, shade = false) {
    return new TableCell({
      shading: shade ? { fill: "F0F0F0" } : undefined,
      children: [new Paragraph({
        children: [new TextRun({ text, bold, size: 20 })],
      })],
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
    });
  }

  function metaRow(label: string, value: string) {
    return new TableRow({ children: [cell(label, true, true), cell(value)] });
  }

  function sectionHeading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]) {
    return new Paragraph({ heading: level, children: [new TextRun({ text, bold: true })] });
  }

  const fullBorder = {
    top: { style: BorderStyle.SINGLE, size: 1, color: "BBBBBB" },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: "BBBBBB" },
    left: { style: BorderStyle.SINGLE, size: 1, color: "BBBBBB" },
    right: { style: BorderStyle.SINGLE, size: 1, color: "BBBBBB" },
  };

  function dataTable(headers: string[], rows: string[][]) {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: fullBorder,
      rows: [
        new TableRow({
          tableHeader: true,
          children: headers.map((h) => cell(h, true, true)),
        }),
        ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) })),
      ],
    });
  }

  const children: (typeof Paragraph.prototype | typeof Table.prototype)[] = [];

  // Title
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `${data.clusterName} Weekly Report (${weekLabel})`, bold: true })],
    }),
    new Paragraph({ children: [] }),
  );

  // Metadata table
  const metaRows = [
    metaRow("Cluster", data.clusterName),
    metaRow("Period", weekLabel),
    ...(selectedPartitions.length ? [metaRow("Partition(s)", selectedPartitions.join(", "))] : []),
    ...(selectedStatuses.length ? [metaRow("Status filter", selectedStatuses.join(", "))] : []),
    ...(selectedUserName ? [metaRow("User", selectedUserName)] : []),
  ];
  children.push(
    new Table({
      width: { size: 60, type: WidthType.PERCENTAGE },
      borders: fullBorder,
      rows: metaRows,
    }),
    new Paragraph({ children: [] }),
  );

  // Weekly Summary
  children.push(sectionHeading("Weekly summary", HeadingLevel.HEADING_2), new Paragraph({ children: [] }));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: fullBorder,
      rows: [new TableRow({
        children: [
          cell("Summary", true, true),
          new TableCell({
            children: bullets.map((b) =>
              new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: b, size: 20 })] }),
            ),
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
          }),
        ],
      })],
    }),
    new Paragraph({ children: [] }),
  );

  // Users this week
  children.push(sectionHeading("1. Users this week", HeadingLevel.HEADING_3));
  children.push(dataTable(
    ["Slurm user", "Name", "Jobs"],
    data.topUsers.map((u) => [u.unixUsername ?? "—", u.name ?? "—", String(u.jobCount)]),
  ), new Paragraph({ children: [] }));

  // Currently running
  children.push(sectionHeading("2. Currently running", HeadingLevel.HEADING_3));
  if (data.currentlyRunning.length) {
    children.push(dataTable(
      ["Job", "User", "State", "Node", "GPUs", "Started", "Elapsed"],
      data.currentlyRunning.map((j) => [
        `${j.jobName}${j.slurmJobId !== null ? ` (ID ${j.slurmJobId})` : ""}`,
        j.unixUsername ?? "—", j.state, j.nodeList ?? "—", fmtGpuAlloc(j),
        j.startedAt, j.elapsedLabel,
      ]),
    ), new Paragraph({ children: [] }));
  } else {
    children.push(new Paragraph({ children: [new TextRun({ text: "No jobs currently running.", italics: true, size: 20 })] }), new Paragraph({ children: [] }));
  }

  // vLLM
  if (data.vllmJobs.length) {
    children.push(sectionHeading("3. Model serving (vLLM)", HeadingLevel.HEADING_3));
    children.push(dataTable(
      ["ID", "Model", "User", "State", "Elapsed"],
      data.vllmJobs.map((j) => [String(j.slurmJobId ?? "—"), j.jobName, j.unixUsername ?? "—", j.state, j.elapsedLabel]),
    ), new Paragraph({ children: [] }));
  }

  // By cluster
  if (data.perCluster.length > 1) {
    children.push(sectionHeading("By cluster", HeadingLevel.HEADING_3));
    children.push(dataTable(
      ["Cluster", "Completed", "Failed", "Cancelled", "GPU-hours", "CPU-hours"],
      data.perCluster.map((c) => [
        c.clusterName, String(c.completed), String(c.failed), String(c.cancelled),
        c.gpuHours.toFixed(1), c.cpuHours.toFixed(0),
      ]),
    ), new Paragraph({ children: [] }));
  }

  // Daily Summary
  children.push(sectionHeading("Daily Summary", HeadingLevel.HEADING_2));

  for (let i = 0; i < data.dailyJobHistory.length; i++) {
    const day = data.dailyJobHistory[i];
    children.push(
      new Paragraph({ children: [] }),
      sectionHeading(`${i + 1}. ${day.dayLabel}`, HeadingLevel.HEADING_3),
    );

    // Summary placeholder
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: fullBorder,
        rows: [new TableRow({
          children: [
            cell("Summary", true, true),
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: `<PLEASE INSERT SUMMARY FOR ${day.dayLabel}>`, color: "888888", italics: true, size: 20 })] })],
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
            }),
          ],
        })],
      }),
      new Paragraph({ children: [] }),
    );

    // GPU charts — render to PNG via Canvas and embed as images
    const chartConfigs = [
      { label: "GPU Memory Used",         series: promData?.memUsed,     divisor: promMeta.memUsed.divisor,     unit: promMeta.memUsed.unit     },
      { label: "GPU Utilization",         series: promData?.utilization, divisor: promMeta.utilization.divisor, unit: promMeta.utilization.unit },
      { label: "GPU Average Temperature", series: promData?.temperature, divisor: promMeta.temperature.divisor, unit: promMeta.temperature.unit },
      { label: "GPU Power Usage",         series: promData?.powerUsage,  divisor: promMeta.powerUsage.divisor,  unit: promMeta.powerUsage.unit  },
    ];

    for (const { label, series, divisor, unit } of chartConfigs) {
      const cd   = series ? buildDayChartData(series, day.date, divisor) : null;
      const ids  = series ? gpuIds(series) : [];
      const png  = await generateChartPng(cd, ids, unit);

      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: fullBorder,
          rows: [new TableRow({
            children: [
              cell(label, true, true),
              new TableCell({
                children: [new Paragraph({
                  children: png
                    ? [new ImageRun({ type: "png", data: png, transformation: { width: 480, height: 150 } })]
                    : [new TextRun({ text: "No Prometheus data available for this day.", color: "888888", italics: true, size: 20 })],
                })],
                margins: { top: 80, bottom: 80, left: 120, right: 120 },
              }),
            ],
          })],
        }),
        new Paragraph({ children: [] }),
      );
    }

    // Job history
    children.push(sectionHeading("Slurm Job History", HeadingLevel.HEADING_4));
    if (day.jobs.length) {
      children.push(dataTable(
        ["ID", "JobName", "User", "State", "Partition", "Node", "GPUs", "Start", "End", "Elapsed"],
        day.jobs.map((j) => [
          String(j.slurmJobId ?? "—"), j.jobName, j.unixUsername ?? "—",
          j.state, j.partition, j.nodeList ?? "—", fmtGpuAlloc(j),
          j.startTime, j.endTime || "—", j.elapsedLabel,
        ]),
      ));
    } else {
      children.push(new Paragraph({ children: [new TextRun({ text: "No completed/cancelled/running jobs started this day.", italics: true, size: 20 })] }));
    }
    children.push(new Paragraph({ children: [] }));
  }

  // Footer
  children.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({
        text: `Generated by SlurmUI · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`,
        color: "888888",
        size: 18,
      })],
    }),
  );

  const doc = new Document({
    styles: {
      paragraphStyles: [{
        id: "Normal",
        name: "Normal",
        basedOn: "Normal",
        run: { font: "Arial", size: 22 },
      }],
    },
    sections: [{ children }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `slurmui-report-${data.period.from.slice(0, 10)}-to-${data.period.to.slice(0, 10)}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const [fromDate, setFromDate] = useState(daysAgo(30));
  const [toDate, setToDate] = useState(today());
  const [clusterId, setClusterId] = useState("__all__");
  const [selectedPartitions, setSelectedPartitions] = useState<string[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<JobStatus[]>([]);
  const [filterUserId, setFilterUserId] = useState("__all__");

  const [data, setData] = useState<ReportData | null>(null);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ partitions: [], partitionNodes: {}, users: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [promData, setPromData] = useState<PromData>(null);
  const [promMeta, setPromMeta] = useState<MetricFamily>(METRIC_FAMILIES.dcgm);
  const [promLoading, setPromLoading] = useState(false);

  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [docxExporting, setDocxExporting] = useState(false);

  // Fetch filter options when cluster changes
  useEffect(() => {
    const params = new URLSearchParams();
    if (clusterId !== "__all__") params.set("clusterId", clusterId);
    fetch(`/api/reports/filters?${params}`).then((r) => r.json()).then(setFilterOptions).catch(() => {});
    setSelectedPartitions([]);
    setPromData(null);
  }, [clusterId]);

  // Fetch report data
  const fetchReport = useCallback(async () => {
    setLoading(true); setError(null);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const params = new URLSearchParams({ from: fromDate, to: toDate, tz });
    if (clusterId !== "__all__") params.set("clusterId", clusterId);
    if (selectedPartitions.length) params.set("partitions", selectedPartitions.join(","));
    if (selectedStatuses.length) params.set("statuses", selectedStatuses.join(","));
    if (filterUserId !== "__all__") params.set("filterUserId", filterUserId);
    try {
      const res = await fetch(`/api/reports?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load report");
    } finally { setLoading(false); }
  }, [fromDate, toDate, clusterId, selectedPartitions, selectedStatuses, filterUserId]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  // Fetch Prometheus data when cluster or date range changes.
  // Step 1: discover metric family via label names, Step 2: query all 4 metrics.
  useEffect(() => {
    if (clusterId === "__all__") { setPromData(null); return; }
    let cancelled = false;
    setPromLoading(true);
    // Parse as LOCAL midnight (append T00:00:00). A bare "YYYY-MM-DD" parses as
    // UTC midnight, which for UTC+8 would start the query at 08:00 local — so the
    // chart never gets 00:00-08:00 data. This window must match the local-midnight
    // boundaries in buildDayChartData() so charts span the client's 00:00->23:59.
    const start = Math.floor(new Date(fromDate + "T00:00:00").getTime() / 1000);
    const end   = Math.floor(new Date(toDate + "T00:00:00").getTime() / 1000) + 86399;
    const step  = promStep(fromDate, toDate);
    const base  = `/api/clusters/${clusterId}/prometheus`;

    const runQuery = async (query: string): Promise<PromSeries[]> => {
      const params = new URLSearchParams({ query, start: String(start), end: String(end), step: String(step) });
      const res = await fetch(`${base}/api/v1/query_range?${params}`);
      if (!res.ok) throw new Error(`Prometheus ${res.status}`);
      return ((await res.json()).data?.result ?? []) as PromSeries[];
    };

    const detectAndFetch = async () => {
      // Discover which exporter family is installed
      let family: MetricFamily = METRIC_FAMILIES.dcgm;
      try {
        const labelsRes = await fetch(`${base}/api/v1/label/__name__/values`);
        if (labelsRes.ok) {
          const names: string[] = (await labelsRes.json()).data ?? [];
          if (names.some((n) => n.startsWith("nvidia_smi_") || n.startsWith("nvidia_gpu_"))) {
            family = METRIC_FAMILIES.nvidia_smi;
          }
          // dcgm stays as default if DCGM_FI_ prefixes found (or unknown)
        }
      } catch { /* fall back to dcgm defaults */ }

      if (!cancelled) setPromMeta(family);

      return Promise.all([
        runQuery(family.memUsed.query),
        runQuery(family.utilization.query),
        runQuery(family.temperature.query),
        runQuery(family.powerUsage.query),
      ]);
    };

    detectAndFetch().then(([memUsed, utilization, temperature, powerUsage]) => {
      if (!cancelled) setPromData({ memUsed, utilization, temperature, powerUsage });
    }).catch(() => {
      if (!cancelled) setPromData(null);
    }).finally(() => {
      if (!cancelled) setPromLoading(false);
    });

    return () => { cancelled = true; };
  }, [clusterId, fromDate, toDate]);

  const toggleDay = (date: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      next.has(date) ? next.delete(date) : next.add(date);
      return next;
    });
  };

  function clearFilters() {
    setClusterId("__all__"); setSelectedPartitions([]); setSelectedStatuses([]);
    setFilterUserId("__all__"); setFromDate(daysAgo(30)); setToDate(today());
  }

  const activeFilterCount = [
    clusterId !== "__all__",
    selectedPartitions.length > 0,
    selectedStatuses.length > 0,
    filterUserId !== "__all__",
  ].filter(Boolean).length;

  const diffDays = Math.ceil(
    (new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000,
  );
  const tickInterval = diffDays <= 7 ? 0 : diffDays <= 30 ? 4 : 13;

  const chartData = (data?.dailyJobHistory ?? []).map((d) => ({
    label: fmtDate(d.date), completed: d.completed, failed: d.failed,
    cancelled: d.cancelled, gpuHours: d.gpuHours, cpuHours: d.cpuHours,
  }));
  const hasJobs    = chartData.some((d) => d.completed + d.failed + d.cancelled > 0);
  const hasCompute = chartData.some((d) => d.gpuHours > 0 || d.cpuHours > 0);

  const weekLabel  = data ? fmtWeekLabel(data.period.from, data.period.to) : "";
  const reportTitle = data ? `${data.clusterName} Weekly Report (${weekLabel})` : "";
  const bullets    = data ? summaryBullets(data) : [];
  const activeJobIds = (data?.currentlyRunning ?? []).map((j) => j.slurmJobId).filter(Boolean) as number[];

  const selectedUserName = filterUserId !== "__all__"
    ? (filterOptions.users.find((u) => u.id === filterUserId)?.unixUsername ?? filterUserId)
    : undefined;

  const partitionNodeInfo = selectedPartitions.length > 0
    ? selectedPartitions.flatMap((p) => {
        const nodes = filterOptions.partitionNodes[p];
        return nodes?.length ? [`${p}: ${nodes.join(", ")}`] : [];
      }).join(" | ")
    : null;

  const vllmSectionNum   = 3;
  const clusterSectionNum = (data?.vllmJobs.length ?? 0) > 0 ? vllmSectionNum + 1 : vllmSectionNum;

  return (
    <div className="space-y-4">

      {/* ════════ SCREEN UI (hidden in print) ════════════════════════════ */}
      <div className="print:hidden space-y-4">

        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold">Reports</h1>
            <p className="text-muted-foreground">Historical job statistics</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="bg-blue-600 text-white hover:bg-blue-700"
              onClick={async () => {
                if (!data) return;
                setDocxExporting(true);
                await exportDocx(data, weekLabel, bullets, selectedPartitions, selectedStatuses, selectedUserName, promData, promMeta).catch(() => {});
                setDocxExporting(false);
              }}
              disabled={loading || !data || docxExporting || promLoading}
            >
              <FileText className="h-4 w-4 mr-2" />
              {docxExporting ? "Generating…" : promLoading ? "Loading GPU data…" : "Export DOCX"}
            </Button>
            <Button
              size="sm"
              className="bg-blue-600 text-white hover:bg-blue-700"
              onClick={() => window.print()}
              disabled={loading || !data}
            >
              <Printer className="h-4 w-4 mr-2" />
              Export PDF
            </Button>
          </div>
        </div>

        {/* Filter bar */}
        <Card className="px-4 py-3">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium w-10">From</span>
              <input type="date" value={fromDate} max={toDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
              <span className="text-xs text-muted-foreground font-medium">To</span>
              <input type="date" value={toDate} min={fromDate} max={today()}
                onChange={(e) => setToDate(capToday(e.target.value))}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
              <div className="flex flex-wrap gap-1 ml-1">
                {DATE_PRESETS.map((p) => (
                  <button key={p.label}
                    onClick={() => { setFromDate(p.from()); setToDate(capToday(p.to())); }}
                    className="h-7 rounded px-2 text-xs border border-border hover:bg-accent hover:text-accent-foreground transition-colors">
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {data && data.clusters.length > 0 && (
                <Select value={clusterId} onValueChange={setClusterId}>
                  <SelectTrigger className="h-8 w-auto min-w-36 text-sm font-normal">
                    <span className="text-muted-foreground text-xs mr-1">Cluster:</span>
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All clusters</SelectItem>
                    {data.clusters.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}

              <MultiSelect label="Partition"
                options={filterOptions.partitions.map((p) => ({ value: p, label: p }))}
                selected={selectedPartitions} onChange={setSelectedPartitions} />

              <MultiSelect label="Status"
                options={ALL_STATUSES.map((s) => ({ value: s, label: s }))}
                selected={selectedStatuses} onChange={(v) => setSelectedStatuses(v as JobStatus[])} />

              {filterOptions.users.length > 1 && (
                <Select value={filterUserId} onValueChange={setFilterUserId}>
                  <SelectTrigger className="h-8 w-auto min-w-36 text-sm font-normal">
                    <span className="text-muted-foreground text-xs mr-1">User:</span>
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All users</SelectItem>
                    {filterOptions.users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>{u.unixUsername ?? u.name ?? u.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {activeFilterCount > 0 && (
                <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground gap-1" onClick={clearFilters}>
                  <X className="h-3 w-3" />
                  Clear
                  <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">{activeFilterCount}</Badge>
                </Button>
              )}
            </div>

            {partitionNodeInfo && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Nodes in partition(s):</span> {partitionNodeInfo}
              </p>
            )}
          </div>
        </Card>

        {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
        {loading && !data && <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">Loading report…</div>}

        {data && (
          <>
            {/* Stat cards */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <StatCard label="Total jobs" value={data.summary.totalJobs} />
              <StatCard label="Completed" value={data.summary.completed} tone="positive" />
              <StatCard label="Failed / Cancelled"
                value={data.summary.failed + data.summary.cancelled}
                tone={data.summary.failed + data.summary.cancelled > 0 ? "negative" : "muted"}
                sub={data.summary.failed + data.summary.cancelled > 0
                  ? `${data.summary.failed} failed, ${data.summary.cancelled} cancelled` : undefined} />
              <StatCard label="Success rate"
                value={data.summary.successRate !== null ? `${data.summary.successRate}%` : "—"}
                tone={data.summary.successRate === null ? "muted"
                  : data.summary.successRate >= 80 ? "positive"
                  : data.summary.successRate >= 50 ? "warning" : "negative"}
                sub={data.summary.completed + data.summary.failed + data.summary.cancelled > 0
                  ? `${data.summary.completed}/${data.summary.completed + data.summary.failed + data.summary.cancelled} finished` : undefined} />
              <StatCard label="GPU-hours"
                value={data.summary.gpuHours > 0 ? data.summary.gpuHours.toFixed(1) : "0"}
                sub={`${data.summary.cpuHours.toFixed(0)} CPU-hours`} />
              <StatCard label="Median duration"
                value={data.summary.medianDurationSec !== null ? fmtDuration(data.summary.medianDurationSec) : "—"}
                sub={data.summary.avgDurationSec !== null ? `avg ${fmtDuration(data.summary.avgDurationSec)}` : undefined} />
            </div>

            {/* Aggregate charts */}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Daily job activity</CardTitle></CardHeader>
                <CardContent>
                  {!hasJobs ? <p className="py-8 text-center text-sm text-muted-foreground">No finished jobs in this period.</p> : (
                    <div className="h-52 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} interval={tickInterval} />
                          <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
                          <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Area type="monotone" dataKey="completed" name="Completed" stackId="1" stroke="var(--chart-2)" fill="var(--chart-2)" fillOpacity={0.25} strokeWidth={2} />
                          <Area type="monotone" dataKey="failed"    name="Failed"    stackId="1" stroke="var(--destructive)" fill="var(--destructive)" fillOpacity={0.25} strokeWidth={2} />
                          <Area type="monotone" dataKey="cancelled" name="Cancelled" stackId="1" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.25} strokeWidth={2} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Compute consumed</CardTitle></CardHeader>
                <CardContent>
                  {!hasCompute ? <p className="py-8 text-center text-sm text-muted-foreground">No compute usage recorded.</p> : (
                    <div className="h-52 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} interval={tickInterval} />
                          <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} width={36} />
                          <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Line type="monotone" dataKey="gpuHours" name="GPU-hours" stroke="var(--chart-2)" strokeWidth={2} dot={{ r: 2 }} />
                          <Line type="monotone" dataKey="cpuHours" name="CPU-hours" stroke="var(--chart-3)" strokeWidth={2} dot={{ r: 2 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Per-cluster table */}
            {data.perCluster.length > 0 && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">By cluster</CardTitle></CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Cluster</TableHead>
                        <TableHead className="text-right">Completed</TableHead>
                        <TableHead className="text-right">Failed</TableHead>
                        <TableHead className="text-right">Cancelled</TableHead>
                        <TableHead className="text-right">Success rate</TableHead>
                        <TableHead className="text-right">GPU-hours</TableHead>
                        <TableHead className="text-right">CPU-hours</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.perCluster.map((c) => {
                        const total = c.completed + c.failed + c.cancelled;
                        const rate  = total > 0 ? Math.round((c.completed / total) * 100) : null;
                        return (
                          <TableRow key={c.clusterName}>
                            <TableCell className="font-mono font-medium">{c.clusterName}</TableCell>
                            <TableCell className="text-right tabular-nums text-chart-2">{c.completed}</TableCell>
                            <TableCell className="text-right tabular-nums text-destructive">{c.failed}</TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">{c.cancelled}</TableCell>
                            <TableCell className="text-right tabular-nums">{rate !== null ? `${rate}%` : "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">{c.gpuHours.toFixed(1)}</TableCell>
                            <TableCell className="text-right tabular-nums">{c.cpuHours.toFixed(0)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {/* Daily breakdown (expandable per-day sections) */}
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Daily breakdown</h2>
              {promLoading && <p className="text-xs text-muted-foreground">Loading Prometheus data…</p>}
              {clusterId === "__all__" && <p className="text-xs text-muted-foreground">Select a specific cluster to see GPU metrics.</p>}

              {data.dailyJobHistory.map((day, i) => {
                const expanded = expandedDays.has(day.date);
                const memCd  = promData ? buildDayChartData(promData.memUsed,     day.date, promMeta.memUsed.divisor)     : null;
                const utilCd = promData ? buildDayChartData(promData.utilization, day.date, promMeta.utilization.divisor) : null;
                const tempCd = promData ? buildDayChartData(promData.temperature, day.date, promMeta.temperature.divisor) : null;
                const powCd  = promData ? buildDayChartData(promData.powerUsage,  day.date, promMeta.powerUsage.divisor)  : null;
                const memIds  = promData ? gpuIds(promData.memUsed) : [];
                const utilIds = promData ? gpuIds(promData.utilization) : [];
                const tempIds = promData ? gpuIds(promData.temperature) : [];
                const powIds  = promData ? gpuIds(promData.powerUsage) : [];

                return (
                  <Card key={day.date}>
                    <button className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent/30 transition-colors"
                      onClick={() => toggleDay(day.date)}>
                      {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                      <span className="font-medium text-sm">{i + 1}. {day.dayLabel}</span>
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {day.completed > 0 && <span className="text-chart-2 mr-2">{day.completed} completed</span>}
                        {day.failed > 0 && <span className="text-destructive mr-2">{day.failed} failed</span>}
                        {day.cancelled > 0 && <span className="mr-2">{day.cancelled} cancelled</span>}
                        {day.jobs.length === 0 && <span>no new jobs</span>}
                      </span>
                    </button>

                    {expanded && (
                      <CardContent className="border-t pt-4 space-y-4">
                        {/* Summary placeholder */}
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Summary</p>
                          <p className="text-sm italic text-muted-foreground px-3 py-2 rounded bg-muted/40">
                            &lt;PLEASE INSERT SUMMARY FOR {day.dayLabel}&gt;
                          </p>
                        </div>

                        {/* GPU charts */}
                        {(promData !== null || clusterId !== "__all__") && (
                          <div className="grid gap-4 md:grid-cols-2">
                            {[
                              { label: "GPU Memory Used",        cd: memCd,  ids: memIds,  unit: promMeta.memUsed.unit     },
                              { label: "GPU Utilization",        cd: utilCd, ids: utilIds, unit: promMeta.utilization.unit },
                              { label: "GPU Average Temperature",cd: tempCd, ids: tempIds, unit: promMeta.temperature.unit },
                              { label: "GPU Power Usage",        cd: powCd,  ids: powIds,  unit: promMeta.powerUsage.unit  },
                            ].map(({ label, cd, ids, unit }) => (
                              <div key={label}>
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
                                <GPUChart chartData={cd} ids={ids} unit={unit} />
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Job history */}
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Slurm Job History</p>
                          {day.jobs.length === 0 ? (
                            <p className="text-sm italic text-muted-foreground">
                              No completed/cancelled/running jobs started this day.
                              {activeJobIds.length > 0 && ` Still active: ${activeJobIds.join(", ")}.`}
                            </p>
                          ) : (
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>ID</TableHead><TableHead>JobName</TableHead>
                                  <TableHead>User</TableHead><TableHead>State</TableHead>
                                  <TableHead>Partition</TableHead><TableHead>Node</TableHead><TableHead>GPUs</TableHead>
                                  <TableHead>Start</TableHead><TableHead>End</TableHead><TableHead>Elapsed</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {day.jobs.map((j, ji) => (
                                  <TableRow key={ji}>
                                    <TableCell className="font-mono text-xs">{j.slurmJobId ?? "—"}</TableCell>
                                    <TableCell className="font-mono text-xs max-w-[180px] truncate">{j.jobName}</TableCell>
                                    <TableCell className="font-mono text-xs">{j.unixUsername ?? "—"}</TableCell>
                                    <TableCell className="text-xs">{j.state}</TableCell>
                                    <TableCell className="font-mono text-xs">{j.partition}</TableCell>
                                    <TableCell className="font-mono text-xs">{j.nodeList ?? "—"}</TableCell>
                                    <TableCell className="font-mono text-xs">{fmtGpuAlloc(j)}</TableCell>
                                    <TableCell className="font-mono text-xs">{j.startTime}</TableCell>
                                    <TableCell className="font-mono text-xs">{j.endTime || "—"}</TableCell>
                                    <TableCell className="font-mono text-xs">{j.elapsedLabel}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          )}
                        </div>
                      </CardContent>
                    )}
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ════════ PRINT-ONLY DOCUMENT ══════════════════════════════════ */}
      {data && (
        <div className="hidden print:block report-document"
          style={{ fontFamily: "Arial, sans-serif", color: "#111", lineHeight: 1.55 }}>

          <h1 style={{ fontSize: "22px", fontWeight: "bold", borderBottom: "2px solid #111", paddingBottom: "8px", marginBottom: "20px" }}>
            {reportTitle}
          </h1>

          <PMetaTable cluster={data.clusterName} week={weekLabel}
            partitions={selectedPartitions} statuses={selectedStatuses} userName={selectedUserName} />

          <h2 style={{ fontSize: "17px", fontWeight: "bold", marginTop: "28px", marginBottom: "12px" }}>Weekly summary</h2>
          <PSummaryBullets bullets={bullets} />

          <h3 style={{ fontSize: "14px", fontWeight: "bold", marginTop: "18px", marginBottom: "8px" }}>1. Users this week</h3>
          <PUsersTable users={data.topUsers} />

          <h3 style={{ fontSize: "14px", fontWeight: "bold", marginTop: "18px", marginBottom: "8px" }}>2. Currently running</h3>
          <PRunningTable jobs={data.currentlyRunning} />

          {data.vllmJobs.length > 0 && (
            <>
              <h3 style={{ fontSize: "14px", fontWeight: "bold", marginTop: "18px", marginBottom: "8px" }}>
                {vllmSectionNum}. Model serving (vLLM)
              </h3>
              <PVllmTable jobs={data.vllmJobs} />
            </>
          )}

          {data.perCluster.length > 1 && (
            <>
              <h3 style={{ fontSize: "14px", fontWeight: "bold", marginTop: "18px", marginBottom: "8px" }}>
                {clusterSectionNum}. By cluster
              </h3>
              <table style={TABLE}>
                <thead><tr>
                  <th style={TH}>Cluster</th><th style={TH}>Completed</th><th style={TH}>Failed</th>
                  <th style={TH}>Cancelled</th><th style={TH}>GPU-hours</th><th style={TH}>CPU-hours</th>
                </tr></thead>
                <tbody>{data.perCluster.map((c) => (
                  <tr key={c.clusterName}>
                    <td style={{ ...TD, fontFamily: "monospace" }}>{c.clusterName}</td>
                    <td style={{ ...TD, textAlign: "right" }}>{c.completed}</td>
                    <td style={{ ...TD, textAlign: "right" }}>{c.failed}</td>
                    <td style={{ ...TD, textAlign: "right" }}>{c.cancelled}</td>
                    <td style={{ ...TD, textAlign: "right" }}>{c.gpuHours.toFixed(1)}</td>
                    <td style={{ ...TD, textAlign: "right" }}>{c.cpuHours.toFixed(0)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </>
          )}

          <h2 style={{ fontSize: "17px", fontWeight: "bold", marginTop: "36px", marginBottom: "4px", borderTop: "1px solid #ccc", paddingTop: "24px" }}>
            Daily Summary
          </h2>

          {data.dailyJobHistory.map((day, i) => {
            const memCd  = promData ? buildDayChartData(promData.memUsed,     day.date, promMeta.memUsed.divisor)     : null;
            const utilCd = promData ? buildDayChartData(promData.utilization, day.date, promMeta.utilization.divisor) : null;
            const tempCd = promData ? buildDayChartData(promData.temperature, day.date, promMeta.temperature.divisor) : null;
            const powCd  = promData ? buildDayChartData(promData.powerUsage,  day.date, promMeta.powerUsage.divisor)  : null;
            const memIds  = promData ? gpuIds(promData.memUsed) : [];
            const utilIds = promData ? gpuIds(promData.utilization) : [];
            const tempIds = promData ? gpuIds(promData.temperature) : [];
            const powIds  = promData ? gpuIds(promData.powerUsage) : [];

            return (
              <div key={day.date} style={{ marginTop: "24px" }}>
                <h3 style={{ fontSize: "15px", fontWeight: "bold", marginBottom: "10px" }}>
                  {i + 1}. {day.dayLabel}
                </h3>

                <h4 style={{ fontSize: "13px", fontWeight: "bold", marginBottom: "6px" }}>a. Summary</h4>
                <table style={TABLE}><tbody>
                  <tr>
                    <td style={{ ...TH, width: "110px", verticalAlign: "top" }}>Summary</td>
                    <td style={{ ...TD, color: "#888", fontStyle: "italic" }}>
                      &lt;PLEASE INSERT SUMMARY FOR {day.dayLabel}&gt;
                    </td>
                  </tr>
                </tbody></table>

                <PGPUChart label="GPU Memory Used"          chartData={memCd}  ids={memIds}  unit={promMeta.memUsed.unit}     />
                <PGPUChart label="GPU Utilization"          chartData={utilCd} ids={utilIds} unit={promMeta.utilization.unit} />
                <PGPUChart label="GPU Avg Temperature"      chartData={tempCd} ids={tempIds} unit={promMeta.temperature.unit} />
                <PGPUChart label="GPU Power Usage"          chartData={powCd}  ids={powIds}  unit={promMeta.powerUsage.unit}  />

                <h4 style={{ fontSize: "13px", fontWeight: "bold", marginBottom: "6px" }}>b. Slurm Job History</h4>
                {day.jobs.length === 0 ? (
                  <p style={{ color: "#555", fontSize: "13px", fontStyle: "italic", marginBottom: "12px" }}>
                    No completed/cancelled/running jobs started this day.
                    {activeJobIds.length > 0 && ` Still active: ${activeJobIds.join(", ")}.`}
                  </p>
                ) : (
                  <PJobHistoryTable jobs={day.jobs} />
                )}
              </div>
            );
          })}

          <p style={{ marginTop: "48px", fontSize: "11px", color: "#888", borderTop: "1px solid #ddd", paddingTop: "12px", textAlign: "right" }}>
            Generated by SlurmUI ·{" "}
            {new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
            {selectedPartitions.length > 0 && ` · Partition: ${selectedPartitions.join(", ")}`}
            {selectedStatuses.length > 0 && ` · Status: ${selectedStatuses.join(", ")}`}
            {selectedUserName && ` · User: ${selectedUserName}`}
          </p>
        </div>
      )}
    </div>
  );
}
