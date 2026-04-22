"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { RefreshCw, Cpu, HardDrive, Zap } from "lucide-react";

interface ProcInfo { pid: number; cpu: number; rss: number; comm: string }
interface GpuInfo {
  index: number; uuid: string; name: string;
  utilization: number; memoryUsedMB: number; memoryTotalMB: number; pids: number[];
}
interface NodeUsage {
  hostname: string;
  reachable: boolean;
  error?: string;
  pids: number[];
  totalCpuPercent: number;
  totalMemoryMB: number;
  cpuCount: number;
  memoryTotalMB: number;
  loadAvg1: number;
  processes: ProcInfo[];
  gpus: GpuInfo[];
}

const REFRESH_OPTIONS = [30, 60, 90, 120] as const;
type RefreshSec = (typeof REFRESH_OPTIONS)[number];

export function JobUsagePanel({ clusterId, jobId }: { clusterId: string; jobId: string }) {
  const [data, setData] = useState<{ nodes: NodeUsage[]; sampledAt?: string; note?: string; debug?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Persist the user's pick across tab switches within the same browser.
  const [refreshSec, setRefreshSec] = useState<RefreshSec>(() => {
    if (typeof window === "undefined") return 30;
    const stored = parseInt(window.localStorage.getItem("aura.usage.refresh") ?? "", 10);
    return (REFRESH_OPTIONS as readonly number[]).includes(stored) ? (stored as RefreshSec) : 30;
  });

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs/${jobId}/usage`);
      if (res.ok) {
        setData(await res.json());
        setError(null);
      } else {
        setError(`Server returned ${res.status}`);
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, refreshSec * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, jobId, refreshSec]);

  const changeRefresh = (sec: RefreshSec) => {
    setRefreshSec(sec);
    try { window.localStorage.setItem("aura.usage.refresh", String(sec)); } catch {}
  };

  if (!data && loading) return <p className="text-sm text-muted-foreground">Sampling...</p>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return null;
  if (data.note) return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{data.note}</p>
      {data.debug && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">scontrol output</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md border bg-black p-2 font-mono text-xs text-green-400 whitespace-pre">{data.debug}</pre>
        </details>
      )}
    </div>
  );
  if (data.nodes.length === 0) return <p className="text-sm text-muted-foreground">No usage data.</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Sampled {data.sampledAt ? new Date(data.sampledAt).toLocaleTimeString() : "—"}.
        </p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Auto-refresh
            <select
              value={refreshSec}
              onChange={(e) => changeRefresh(parseInt(e.target.value, 10) as RefreshSec)}
              className="rounded border bg-background px-1.5 py-0.5 text-xs font-mono"
            >
              {REFRESH_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}s</option>
              ))}
            </select>
          </label>
          <button
            onClick={fetchData}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {data.nodes.map((node) => (
        <Card key={node.hostname}>
          <CardContent className="space-y-3 pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-mono text-sm font-medium">{node.hostname}</p>
                <p className="text-xs text-muted-foreground">
                  {node.pids.length} job pids · load {node.loadAvg1.toFixed(2)}
                </p>
              </div>
              {!node.reachable && (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600">
                  unreachable
                </span>
              )}
            </div>
            {node.error && (
              <details className="text-xs">
                <summary className="cursor-pointer text-amber-600">SSH error</summary>
                <pre className="mt-1 max-h-32 overflow-auto rounded-md border bg-black p-2 font-mono text-[10px] text-red-400 whitespace-pre-wrap">{node.error}</pre>
              </details>
            )}

            <div className="grid gap-3 md:grid-cols-2">
              <UsageBar
                icon={<Cpu className="h-3 w-3" />}
                label="CPU"
                value={node.totalCpuPercent}
                max={node.cpuCount * 100}
                suffix={`${(node.totalCpuPercent / 100).toFixed(1)} / ${node.cpuCount} cores`}
              />
              <UsageBar
                icon={<HardDrive className="h-3 w-3" />}
                label="RAM"
                value={node.totalMemoryMB}
                max={node.memoryTotalMB}
                suffix={`${fmtMB(node.totalMemoryMB)} / ${fmtMB(node.memoryTotalMB)}`}
              />
            </div>

            {node.gpus.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <Zap className="h-3 w-3" /> GPU
                </p>
                {node.gpus.map((g) => (
                  <div key={g.uuid} className="rounded-md border p-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-mono">
                        [{g.index}] {g.name}
                        {g.pids.length > 0 && (
                          <span className="ml-2 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                            job pid × {g.pids.length}
                          </span>
                        )}
                      </span>
                      <span className="text-muted-foreground">
                        util {g.utilization}% · mem {fmtMB(g.memoryUsedMB)} / {fmtMB(g.memoryTotalMB)}
                      </span>
                    </div>
                    <Bar value={g.utilization} max={100} className="mt-1" />
                  </div>
                ))}
              </div>
            )}

            {node.processes.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Top processes ({node.processes.length})
                </summary>
                <div className="mt-2 space-y-1 font-mono">
                  {node.processes.map((p) => (
                    <div key={p.pid} className="flex gap-2">
                      <span className="w-14 text-muted-foreground">{p.pid}</span>
                      <span className="w-16 text-right">{p.cpu.toFixed(1)}%</span>
                      <span className="w-20 text-right">{fmtMB(Math.round(p.rss / 1024))}</span>
                      <span className="flex-1 truncate">{p.comm}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function UsageBar({
  icon, label, value, max, suffix,
}: { icon: React.ReactNode; label: string; value: number; max: number; suffix: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 font-medium">{icon}{label}</span>
        <span className="text-muted-foreground">{suffix}</span>
      </div>
      <Bar value={value} max={max} className="mt-1" />
    </div>
  );
}

function Bar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color = pct > 90 ? "bg-destructive" : pct > 70 ? "bg-amber-500" : "bg-primary";
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-muted ${className ?? ""}`}>
      <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function fmtMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}
