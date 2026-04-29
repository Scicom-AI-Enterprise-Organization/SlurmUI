"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Loader2, AlertCircle, ExternalLink } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";

// PromQL query templates. Each returns a series-per-instance (and per-gpu
// where applicable). The `or` operator falls through to whichever exporter
// is actually publishing — DCGM names first, then utkuozdemir/nvidia_smi
// alternates. Whichever returns rows wins.
const QUERIES = {
  gpuUtil: `(DCGM_FI_DEV_GPU_UTIL) or (nvidia_smi_utilization_gpu_ratio * 100) or (nvidia_smi_gpu_utilization_percentage)`,
  gpuMemPct:
    `(100 * DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE)) or (100 * nvidia_smi_memory_used_bytes / nvidia_smi_memory_total_bytes)`,
  gpuTemp: `(DCGM_FI_DEV_GPU_TEMP) or (nvidia_smi_temperature_celsius) or (nvidia_smi_temperature_gpu_celsius)`,
  gpuPower: `(DCGM_FI_DEV_POWER_USAGE) or (nvidia_smi_power_draw_watts)`,
  cpuPct: `100 - (avg by (instance) (irate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)`,
  memPct: `100 * (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))`,
} as const;

type RangeKey = "5m" | "15m" | "1h" | "6h" | "24h";
const RANGES: Record<RangeKey, { seconds: number; step: number }> = {
  "5m": { seconds: 5 * 60, step: 15 },
  "15m": { seconds: 15 * 60, step: 30 },
  "1h": { seconds: 60 * 60, step: 60 },
  "6h": { seconds: 6 * 60 * 60, step: 300 },
  "24h": { seconds: 24 * 60 * 60, step: 600 },
};

interface PromValue {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

interface Series {
  name: string;
  points: Array<{ t: number; v: number }>;
}

interface ChartPoint {
  t: number;
  [key: string]: number;
}

function seriesLabel(metric: Record<string, string>): string {
  const inst = metric.instance ?? metric.exported_instance ?? "?";
  const gpu = metric.gpu ?? metric.UUID ?? metric.uuid ?? metric.modelName ?? "";
  return gpu ? `${inst}/${gpu}` : inst;
}

function toChartPoints(seriesList: Series[]): ChartPoint[] {
  // Outer-join all series on timestamp. Sparse points become `null` so
  // recharts skips them rather than zero-filling.
  const all = new Map<number, ChartPoint>();
  for (const s of seriesList) {
    for (const p of s.points) {
      let row = all.get(p.t);
      if (!row) { row = { t: p.t }; all.set(p.t, row); }
      row[s.name] = p.v;
    }
  }
  return Array.from(all.values()).sort((a, b) => a.t - b.t);
}

async function queryRange(
  clusterId: string,
  promql: string,
  range: { seconds: number; step: number },
): Promise<Series[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - range.seconds;
  const params = new URLSearchParams({
    query: promql,
    start: String(start),
    end: String(end),
    step: String(range.step),
  });
  const r = await fetch(`/api/clusters/${clusterId}/prometheus/api/v1/query_range?${params}`);
  if (!r.ok) {
    // Tag well-known proxy errors with sentinel codes so the UI can render
    // a friendly empty-state instead of the raw HTTP body. Anything else
    // gets surfaced verbatim for debugging.
    let body: { error?: string } = {};
    try { body = await r.json(); } catch {}
    if (r.status === 412 && /metrics disabled/i.test(body.error ?? "")) {
      throw new Error("__METRICS_DISABLED__");
    }
    if (r.status === 412 && /no ssh/i.test(body.error ?? "")) {
      throw new Error("__NO_SSH__");
    }
    throw new Error(body.error ?? `request failed (${r.status})`);
  }
  const d = await r.json();
  if (d.status !== "success") throw new Error(d.error || "query failed");
  const result = (d.data?.result ?? []) as PromValue[];
  return result.map((row) => ({
    name: seriesLabel(row.metric),
    points: row.values.map(([t, v]) => ({ t: t * 1000, v: Number(v) })).filter((p) => Number.isFinite(p.v)),
  }));
}

const COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4", "#84cc16", "#ec4899"];

export default function UserMetricsPage() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useState<RangeKey>("15m");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<Record<keyof typeof QUERIES, Series[]>>({
    gpuUtil: [], gpuMemPct: [], gpuTemp: [], gpuPower: [], cpuPct: [], memPct: [],
  });
  const [errors, setErrors] = useState<Partial<Record<keyof typeof QUERIES, string>>>({});
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErrors({});
      const r = RANGES[range];
      const keys = Object.keys(QUERIES) as Array<keyof typeof QUERIES>;
      const results = await Promise.allSettled(
        keys.map((k) => queryRange(id, QUERIES[k], r)),
      );
      if (cancelled) return;
      const next = { ...data };
      const errs: Partial<Record<keyof typeof QUERIES, string>> = {};
      let firstFatal: string | null = null;
      results.forEach((res, i) => {
        const k = keys[i];
        if (res.status === "fulfilled") {
          next[k] = res.value;
        } else {
          errs[k] = res.reason instanceof Error ? res.reason.message : String(res.reason);
          if (!firstFatal && /^__(METRICS_DISABLED|NO_SSH)__$/.test(errs[k]!)) firstFatal = errs[k]!;
        }
      });
      setData(next);
      setErrors(errs);
      setDisabled(firstFatal);
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, range, tick]);

  useEffect(() => {
    if (!autoRefresh) return;
    const i = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(i);
  }, [autoRefresh]);

  const charts = useMemo(() => ([
    { key: "gpuUtil" as const, title: "GPU utilization (%)", unit: "%", domain: [0, 100] as [number, number] },
    { key: "gpuMemPct" as const, title: "GPU memory used (%)", unit: "%", domain: [0, 100] as [number, number] },
    { key: "gpuTemp" as const, title: "GPU temperature (°C)", unit: "°C", domain: [0, "auto"] as [number, "auto"] },
    { key: "gpuPower" as const, title: "GPU power (W)", unit: "W", domain: [0, "auto"] as [number, "auto"] },
    { key: "cpuPct" as const, title: "Host CPU (%)", unit: "%", domain: [0, 100] as [number, number] },
    { key: "memPct" as const, title: "Host memory (%)", unit: "%", domain: [0, 100] as [number, number] },
  ]), []);

  if (disabled) {
    // Map the sentinel codes from queryRange to user-facing copy. Anything
    // else falls back to a generic notice — we deliberately don't surface
    // raw HTTP bodies / status codes here.
    const friendly =
      disabled === "__METRICS_DISABLED__"
        ? "The metrics stack hasn't been deployed for this cluster yet."
        : disabled === "__NO_SSH__"
          ? "This cluster doesn't have SSH connectivity configured, so we can't fetch live metrics."
          : "Metrics aren't available for this cluster right now.";
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <p className="text-base font-medium">Metrics not available</p>
        <p className="text-sm text-muted-foreground max-w-md">{friendly}</p>
        <p className="text-xs text-muted-foreground">
          An admin can enable the metrics stack from the cluster&apos;s Metrics tab.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Metrics</h2>
          <p className="text-xs text-muted-foreground">
            Live from this cluster&apos;s Prometheus. Auto-refreshes every 30s.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href={`/grafana-proxy/${id}/`} target="_blank" rel="noreferrer">
            <Button size="sm" variant="outline" className="h-8">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Grafana
            </Button>
          </a>
          <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
            <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="5m">Last 5 min</SelectItem>
              <SelectItem value="15m">Last 15 min</SelectItem>
              <SelectItem value="1h">Last 1 hour</SelectItem>
              <SelectItem value="6h">Last 6 hours</SelectItem>
              <SelectItem value="24h">Last 24 hours</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm" variant={autoRefresh ? "default" : "outline"}
            onClick={() => setAutoRefresh((a) => !a)}
            className="h-8"
          >
            {autoRefresh ? "Auto" : "Manual"}
          </Button>
          <Button
            size="sm" variant="outline" className="h-8"
            onClick={() => setTick((t) => t + 1)} disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {loading && Object.values(data).every((s) => s.length === 0) ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {charts.map((c) => {
            const series = data[c.key];
            const points = toChartPoints(series);
            const err = errors[c.key];
            return (
              <Card key={c.key}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center justify-between">
                    <span>{c.title}</span>
                    {series.length > 0 && (
                      <Badge variant="outline" className="text-xs">{series.length} series</Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {err ? (
                    // Hide sentinel codes (already covered by the page-level
                    // disabled banner) and don't dump raw HTTP bodies into
                    // the per-card area.
                    <p className="text-xs text-red-600">
                      {/^__(METRICS_DISABLED|NO_SSH)__$/.test(err)
                        ? "Metrics not available."
                        : err}
                    </p>
                  ) : points.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-8 text-center">No data</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                        <XAxis
                          dataKey="t"
                          type="number"
                          domain={["dataMin", "dataMax"]}
                          tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          tick={{ fontSize: 10 }}
                        />
                        <YAxis
                          domain={c.domain as [number | string, number | string]}
                          tick={{ fontSize: 10 }}
                          width={36}
                          tickFormatter={(v) => `${v}${c.unit === "%" ? "" : ""}`}
                        />
                        <Tooltip
                          labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
                          formatter={(v) => {
                            const n = typeof v === "number" ? v : Number(v);
                            return [Number.isFinite(n) ? `${n.toFixed(1)} ${c.unit}` : String(v ?? "—"), ""];
                          }}
                          contentStyle={{ fontSize: 11 }}
                        />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        {series.map((s, i) => (
                          <Line
                            key={s.name}
                            type="monotone"
                            dataKey={s.name}
                            stroke={COLORS[i % COLORS.length]}
                            strokeWidth={1.5}
                            dot={false}
                            isAnimationActive={false}
                            connectNulls
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
