"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Activity, Cpu, RefreshCw, Loader2, Trash2, Play, Eye, EyeOff, Copy, Zap, Stethoscope, ExternalLink, FileText } from "lucide-react";

type ExporterMode = "auto" | "dcgm" | "nvidia_smi";

interface NodeStatus {
  hostname: string;
  ip: string;
  installed: boolean;
  exporter?: "dcgm" | "nvidia_smi";
  installedAt?: string;
  nodeExporter: "up" | "loopback_only" | "down" | "unknown";
  gpuExporter: "up" | "loopback_only" | "down" | "unknown" | "no_gpu";
}

interface MetricsConfig {
  enabled: boolean;
  exporterMode: ExporterMode;
  prometheusPort: number;
  grafanaPort: number;
  retention: string;
  stackHost?: string;
  stackDataPath?: string;
  nodes: Record<string, { exporter?: "dcgm" | "nvidia_smi"; installedAt?: string; scrape?: boolean }>;
  grafanaAdminPassword?: string;
  grafanaDeployedAt?: string;
}

interface StackStatus {
  host?: string;
  isController?: boolean;
  prometheus: "up" | "down";
  grafana: "up" | "down";
  grafanaDeployedAt: string | null;
}

export default function MetricsPage() {
  const params = useParams();
  const clusterId = params.id as string;

  const [cfg, setCfg] = useState<MetricsConfig | null>(null);
  const [nodes, setNodes] = useState<NodeStatus[]>([]);
  const [stack, setStack] = useState<StackStatus | null>(null);
  const [stackHostCandidates, setStackHostCandidates] = useState<string[]>([]);
  const [controllerHost, setControllerHost] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [copied, setCopied] = useState(false);

  // Diagnose dialog state
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagHost, setDiagHost] = useState<string>("");
  const [diagOutput, setDiagOutput] = useState<string>("");
  const [diagRunning, setDiagRunning] = useState(false);

  // Stack-service journalctl viewer
  const [svcLogOpen, setSvcLogOpen] = useState(false);
  const [svcLogService, setSvcLogService] = useState<"grafana" | "prometheus">("grafana");
  const [svcLogOutput, setSvcLogOutput] = useState<string>("");
  const [svcLogLoading, setSvcLogLoading] = useState(false);
  const svcLogRef = useRef<HTMLDivElement>(null);

  // Live-log dialog state (mirrors packages-tab pattern)
  const [logDialog, setLogDialog] = useState(false);
  const [logTitle, setLogTitle] = useState("Working");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logStatus, setLogStatus] = useState<"running" | "success" | "failed">("running");
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const sr = await fetch(`/api/clusters/${clusterId}/metrics/status`);
      if (sr.ok) {
        const d = await sr.json();
        setCfg(d.metrics);
        setNodes(d.nodes ?? []);
        setStack(d.stack ?? null);
      }
    } finally {
      if (!silent) setRefreshing(false);
      setLoading(false);
    }
  };

  // Stack host options + controller hostname come from /metrics (not /status),
  // so fetch once on mount. Also re-attach to any in-progress metrics task
  // so a page reload mid-deploy doesn't orphan the live log.
  useEffect(() => {
    fetch(`/api/clusters/${clusterId}/metrics`)
      .then((r) => r.json())
      .then((d) => {
        setStackHostCandidates(d.stackHostCandidates ?? ["controller"]);
        setControllerHost(d.controllerHost ?? "");
        if (d.latestTask && d.latestTask.status === "running") {
          const titleByType: Record<string, string> = {
            metrics_install: "Installing exporters",
            metrics_uninstall: "Removing exporters",
            metrics_grafana_deploy: "Deploying Prometheus + Grafana",
            metrics_grafana_teardown: "Tearing down stack",
          };
          attachToTask(d.latestTask.id, titleByType[d.latestTask.type] ?? "Working");
          // Don't auto-open the dialog on reload — the banner cues the user.
          setLogDialog(false);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const attachToTask = (taskId: string, title: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    setCurrentTaskId(taskId);
    setLogTitle(title);
    setLogLines([]);
    setLogStatus("running");
    setLogDialog(true);
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}`);
        if (!r.ok) return;
        const t = await r.json();
        setLogLines(t.logs ? t.logs.split("\n") : []);
        if (t.status === "success" || t.status === "failed") {
          setLogStatus(t.status);
          if (pollRef.current) clearInterval(pollRef.current);
          setCurrentTaskId(null);
          refresh(true);
        }
      } catch {}
    }, 2000);
  };

  const cancelTask = async () => {
    if (!currentTaskId) return;
    try {
      await fetch(`/api/tasks/${currentTaskId}/cancel`, { method: "POST" });
    } catch {}
  };

  const installNode = async (hostname: string) => {
    try {
      const r = await fetch(`/api/clusters/${clusterId}/metrics/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostnames: [hostname] }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || "Install failed");
        return;
      }
      attachToTask(d.taskId, `Installing exporters on ${hostname}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Install failed");
    }
  };

  const installAll = async () => {
    if (nodes.length === 0) return;
    try {
      const r = await fetch(`/api/clusters/${clusterId}/metrics/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!r.ok) { toast.error(d.error || "Install failed"); return; }
      attachToTask(d.taskId, `Installing exporters on ${nodes.length} node(s)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Install failed");
    }
  };

  const openServiceLogs = async (svc: "grafana" | "prometheus") => {
    setSvcLogService(svc);
    setSvcLogOpen(true);
    setSvcLogOutput("");
    setSvcLogLoading(true);
    try {
      const r = await fetch(`/api/clusters/${clusterId}/metrics/logs?service=${svc}&lines=400`);
      const d = await r.json();
      if (!r.ok) {
        setSvcLogOutput(`Error: ${d.error ?? r.statusText}`);
      } else {
        setSvcLogOutput(d.output || "(empty)");
      }
    } catch (e) {
      setSvcLogOutput(`Error: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setSvcLogLoading(false);
      // Scroll to bottom (most recent logs).
      setTimeout(() => {
        if (svcLogRef.current) svcLogRef.current.scrollTop = svcLogRef.current.scrollHeight;
      }, 50);
    }
  };

  const diagnoseNode = async (hostname: string) => {
    setDiagHost(hostname);
    setDiagOutput("");
    setDiagOpen(true);
    setDiagRunning(true);
    try {
      const r = await fetch(`/api/clusters/${clusterId}/metrics/diagnose?host=${encodeURIComponent(hostname)}`);
      const d = await r.json();
      if (!r.ok) {
        setDiagOutput(`Error: ${d.error ?? r.statusText}`);
      } else {
        setDiagOutput(d.output || "(empty output)");
      }
    } catch (e) {
      setDiagOutput(`Error: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setDiagRunning(false);
    }
  };

  const uninstallNode = async (hostname: string) => {
    if (!confirm(`Remove metrics exporters from ${hostname}?`)) return;
    try {
      const r = await fetch(`/api/clusters/${clusterId}/metrics/uninstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostnames: [hostname] }),
      });
      const d = await r.json();
      if (!r.ok) { toast.error(d.error || "Uninstall failed"); return; }
      attachToTask(d.taskId, `Removing exporters from ${hostname}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Uninstall failed");
    }
  };

  const deployStack = async () => {
    try {
      const r = await fetch(`/api/clusters/${clusterId}/metrics/grafana/deploy`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) { toast.error(d.error || "Deploy failed"); return; }
      attachToTask(d.taskId, "Deploying Prometheus + Grafana");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Deploy failed");
    }
  };

  const teardownStack = async () => {
    if (!confirm("Tear down Prometheus + Grafana on the controller? Historical data will be deleted.")) return;
    try {
      const r = await fetch(`/api/clusters/${clusterId}/metrics/grafana/teardown`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) { toast.error(d.error || "Teardown failed"); return; }
      attachToTask(d.taskId, "Tearing down stack");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Teardown failed");
    }
  };

  const saveCfg = async (patch: Partial<MetricsConfig>) => {
    if (!cfg) return;
    setSavingCfg(true);
    try {
      const r = await fetch(`/api/clusters/${clusterId}/metrics`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = await r.json();
      if (!r.ok) { toast.error(d.error || "Save failed"); return; }
      setCfg((c) => (c ? { ...c, ...d.metrics } : c));
    } finally {
      setSavingCfg(false);
    }
  };

  if (loading || !cfg) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const installedCount = Object.keys(cfg.nodes ?? {}).length;
  const isDone = logStatus !== "running";

  return (
    <div className="space-y-6 py-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Metrics</h2>
          <p className="text-sm text-muted-foreground">
            GPU + host telemetry via the upstream{" "}
            <a
              href="https://github.com/Scicom-AI-Enterprise-Organization/gpu-metrics-exporter"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              gpu-metrics-exporter
            </a>
            . Optional Prometheus + Grafana deployed on the controller.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refresh()} disabled={refreshing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <Label className="text-xs">Default exporter</Label>
              <Select
                value={cfg.exporterMode}
                onValueChange={(v) => saveCfg({ exporterMode: v as ExporterMode })}
                disabled={savingCfg}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-detect</SelectItem>
                  <SelectItem value="dcgm">DCGM (docker)</SelectItem>
                  <SelectItem value="nvidia_smi">nvidia-smi (binary)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Prometheus port</Label>
              <Input
                type="number"
                defaultValue={cfg.prometheusPort}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (v && v !== cfg.prometheusPort) saveCfg({ prometheusPort: v });
                }}
              />
            </div>
            <div>
              <Label className="text-xs">Grafana port</Label>
              <Input
                type="number"
                defaultValue={cfg.grafanaPort}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (v && v !== cfg.grafanaPort) saveCfg({ grafanaPort: v });
                }}
              />
            </div>
            <div>
              <Label className="text-xs">Retention</Label>
              <Input
                defaultValue={cfg.retention}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== cfg.retention) saveCfg({ retention: v });
                }}
                placeholder="15d"
              />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label className="text-xs">Stack host (Prometheus + Grafana)</Label>
              <Select
                value={cfg.stackHost ?? "controller"}
                onValueChange={(v) => saveCfg({ stackHost: v })}
                disabled={savingCfg || stackHostCandidates.length === 0}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {stackHostCandidates.map((h) => (
                    <SelectItem key={h} value={h}>
                      {h === "controller" ? `controller${controllerHost ? ` (${controllerHost})` : ""}` : h}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Re-deploy after changing — the prometheus + grafana systemd services stay on the previous host until you tear them down.
              </p>
            </div>
            <div>
              <Label className="text-xs">Stack data path (optional)</Label>
              <Input
                defaultValue={cfg.stackDataPath ?? ""}
                placeholder="/var/lib/aura-metrics"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (cfg.stackDataPath ?? "")) saveCfg({ stackDataPath: v });
                }}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Where the prometheus + grafana binaries store their data. Two sub-dirs created: <code>prometheus/</code>, <code>grafana/</code>. Default <code>/var/lib/aura-metrics</code>.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Prometheus + Grafana stack
            </CardTitle>
            {stack && (
              <p className="text-xs text-muted-foreground mt-1">
                On <span className="font-medium text-foreground">{stack.host ?? "controller"}</span>
                {stack.isController ? " (controller)" : ""} — Prometheus{" "}
                <Badge variant="outline" className={stack.prometheus === "up" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                  {stack.prometheus}
                </Badge>{" "}· Grafana{" "}
                <Badge variant="outline" className={stack.grafana === "up" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                  {stack.grafana}
                </Badge>
                {stack.grafanaDeployedAt && (
                  <span className="ml-2" suppressHydrationWarning>
                    · deployed {new Date(stack.grafanaDeployedAt).toLocaleString()}
                  </span>
                )}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline" size="sm"
              onClick={() => openServiceLogs("prometheus")}
              disabled={!stack || stack.prometheus === "down"}
              title="View prometheus systemd logs"
            >
              <FileText className="mr-2 h-4 w-4" />
              Prometheus logs
            </Button>
            <Button
              variant="outline" size="sm"
              onClick={() => openServiceLogs("grafana")}
              disabled={!stack || stack.grafana === "down"}
              title="View grafana systemd logs"
            >
              <FileText className="mr-2 h-4 w-4" />
              Grafana logs
            </Button>
            {stack?.grafana === "up" && (
              <a
                href={`/grafana-proxy/${clusterId}/`}
                target="_blank"
                rel="noreferrer"
              >
                <Button variant="outline" size="sm">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open Grafana
                </Button>
              </a>
            )}
            <Button onClick={deployStack} size="sm" disabled={installedCount === 0}>
              <Play className="mr-2 h-4 w-4" />
              {stack?.grafana === "up" ? "Re-deploy" : "Deploy"}
            </Button>
            {stack?.grafana === "up" && (
              <Button variant="outline" size="sm" onClick={teardownStack}>
                <Trash2 className="mr-2 h-4 w-4" />
                Tear down
              </Button>
            )}
          </div>
        </CardHeader>
        {(cfg.grafanaAdminPassword || installedCount === 0) && (
          <CardContent className="space-y-2">
            {installedCount === 0 && (
              <p className="text-sm text-muted-foreground">
                Install exporters on at least one node before deploying the stack.
              </p>
            )}
            {cfg.grafanaAdminPassword && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-xs font-mono">
                <span className="text-muted-foreground">grafana login:</span>
                <span>admin /</span>
                <span>{showPwd ? cfg.grafanaAdminPassword : "••••••••••••••"}</span>
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setShowPwd((s) => !s)}>
                  {showPwd ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
                <span className="relative inline-flex">
                  <Button
                    size="icon" variant="ghost" className="h-6 w-6"
                    title="Copy password"
                    onClick={() => {
                      if (cfg.grafanaAdminPassword) {
                        navigator.clipboard.writeText(cfg.grafanaAdminPassword);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  {copied && (
                    <span className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[10px] font-sans text-popover-foreground shadow-md">
                      Copied
                    </span>
                  )}
                </span>
                <span className="ml-auto text-muted-foreground">rotates on every deploy</span>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Cpu className="h-4 w-4" />
            Per-node exporters
          </CardTitle>
          <Button onClick={installAll} size="sm" disabled={nodes.length === 0}>
            Install on all
          </Button>
        </CardHeader>
        <CardContent>
          {nodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No nodes registered yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Node</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Exporter</TableHead>
                  <TableHead>node_exporter :9100</TableHead>
                  <TableHead>gpu :9400</TableHead>
                  <TableHead className="w-[120px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nodes.map((n) => (
                  <TableRow key={n.hostname}>
                    <TableCell className="font-medium">{n.hostname}</TableCell>
                    <TableCell className="font-mono text-xs">{n.ip}</TableCell>
                    <TableCell>
                      {n.installed ? (
                        <Badge variant="outline">{n.exporter ?? "unknown"}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">not installed</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusDot value={n.nodeExporter} />
                    </TableCell>
                    <TableCell>
                      <StatusDot value={n.gpuExporter} />
                    </TableCell>
                    <TableCell className="space-x-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={n.installed ? "Re-install exporters" : "Install exporters"}
                        onClick={() => installNode(n.hostname)}
                      >
                        <Zap className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Diagnose (probe :9100/:9400, units, docker, nvidia-smi)"
                        onClick={() => diagnoseNode(n.hostname)}
                      >
                        <Stethoscope className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive"
                        title={n.installed ? "Remove exporters" : "Nothing to remove"}
                        onClick={() => uninstallNode(n.hostname)}
                        disabled={!n.installed}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={logDialog} onOpenChange={setLogDialog}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-3 pr-8">
              <span className="truncate">{logTitle}</span>
              <Badge variant="outline" className={
                logStatus === "running" ? "bg-blue-100 text-blue-800"
                : logStatus === "success" ? "bg-green-100 text-green-800"
                : "bg-red-100 text-red-800"
              }>
                {logStatus}
              </Badge>
            </DialogTitle>
            <DialogDescription className="sr-only">Live install / deploy logs</DialogDescription>
          </DialogHeader>
          <div ref={logRef} className="h-[420px] overflow-y-auto rounded-md border bg-black p-4 font-mono text-xs text-green-400">
            {logLines.length === 0 ? (
              <p className="text-gray-500">Waiting for output...</p>
            ) : (
              logLines.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap leading-5">{l}</div>
              ))
            )}
          </div>
          <DialogFooter>
            {!isDone && currentTaskId && (
              <>
                <Button variant="outline" onClick={() => setLogDialog(false)}>Run in background</Button>
                <Button variant="destructive" onClick={cancelTask}>Cancel</Button>
              </>
            )}
            {isDone && (
              <DialogClose asChild>
                <Button variant="outline">Close</Button>
              </DialogClose>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={diagOpen} onOpenChange={setDiagOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Diagnose: {diagHost}</DialogTitle>
            <DialogDescription className="sr-only">Read-only probe of node metrics endpoints</DialogDescription>
          </DialogHeader>
          <div className="h-[420px] overflow-y-auto rounded-md border bg-black p-4 font-mono text-xs text-green-400 whitespace-pre-wrap">
            {diagRunning && !diagOutput ? "Probing..." : diagOutput || "(no output)"}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={svcLogOpen} onOpenChange={setSvcLogOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="pr-8">
              {svcLogService} logs {stack?.host && <span className="text-xs font-normal text-muted-foreground">— on {stack.host}</span>}
            </DialogTitle>
            <DialogDescription className="sr-only">journalctl tail of the {svcLogService} systemd unit</DialogDescription>
          </DialogHeader>
          <div ref={svcLogRef} className="h-[480px] overflow-y-auto rounded-md border bg-black p-4 font-mono text-xs text-green-400 whitespace-pre-wrap">
            {svcLogLoading && !svcLogOutput ? "Loading..." : svcLogOutput || "(no output)"}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => openServiceLogs(svcLogService)} disabled={svcLogLoading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${svcLogLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusDot({ value }: { value: NodeStatus["nodeExporter"] | NodeStatus["gpuExporter"] }) {
  if (value === "up") return <Badge variant="outline" className="bg-green-100 text-green-800">up</Badge>;
  if (value === "loopback_only") return <Badge variant="outline" className="bg-amber-100 text-amber-800" title="Bound to 127.0.0.1 only — Prometheus on another host can't scrape">loopback only</Badge>;
  if (value === "down") return <Badge variant="outline" className="bg-red-100 text-red-800">down</Badge>;
  if (value === "no_gpu") return <Badge variant="outline" className="text-muted-foreground">no GPU</Badge>;
  return <Badge variant="outline" className="text-muted-foreground">—</Badge>;
}
