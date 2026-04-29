"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save, AlertCircle } from "lucide-react";

interface Props {
  clusterId: string;
  jobId: string;
  initialMetricsPort: number | null;
}

/**
 * Per-job toggle for "Prometheus should scrape this job's /metrics endpoint".
 * Used for vLLM (default :8000) and any other long-running service jobs that
 * expose Prometheus metrics on a known port.
 *
 * Saving PATCHes the Job and triggers a server-side refresh of the cluster's
 * Prometheus file_sd targets so the change shows up within ~30s without the
 * user clicking anything else. The vLLM dashboard provisioned at deploy time
 * picks these series up via the `aura-job` job label.
 */
export function ExposeMetricsTab({ clusterId, jobId, initialMetricsPort }: Props) {
  const [enabled, setEnabled] = useState(initialMetricsPort !== null);
  const [port, setPort] = useState<string>(
    initialMetricsPort !== null ? String(initialMetricsPort) : "8000",
  );
  const [saving, setSaving] = useState(false);
  // Refresh status from the metrics tab after save so user sees the
  // confirmation that prometheus reloaded with their target.
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<{ targets: number; nodes: number } | null>(null);
  // Inline confirmation rendered next to the Save button — replaces the
  // previous "Scrape disabled" / "Prometheus will scrape this job" toast.
  const [saveStatus, setSaveStatus] = useState<"scraping" | "disabled" | null>(null);
  // Inline error displayed under the form. Shows the full server response so
  // the user can act on it instead of staring at a toast that says
  // "HTTP 500" with no detail.
  const [error, setError] = useState<{ where: "save" | "refresh"; status: number; message: string; raw?: string } | null>(null);
  // Live probe of the cluster's Prometheus. We disable the controls when
  // the stack isn't deployed or Prometheus isn't responding — saving a
  // metricsPort that nothing will ever scrape just creates dead Job rows.
  const [stack, setStack] = useState<{ enabled: boolean; prometheusUp: boolean; loading: boolean }>({
    enabled: false, prometheusUp: false, loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/clusters/${clusterId}/metrics/quick-status`)
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((d) => {
        if (cancelled) return;
        setStack({
          enabled: !!d.enabled,
          prometheusUp: !!d.prometheusUp,
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setStack({ enabled: false, prometheusUp: false, loading: false });
      });
    return () => { cancelled = true; };
  }, [clusterId]);

  const stackReady = stack.enabled && stack.prometheusUp;

  const save = async (newEnabled: boolean, newPort: number | null) => {
    setSaving(true);
    setError(null);
    try {
      // Pre-flight: when turning the toggle ON, ensure the port actually
      // serves Prometheus metrics on at least one of the job's nodes. We
      // refuse to save unscrapable ports — a "saved but Prometheus fails
      // to scrape" target is worse than a clear refusal because it leaves
      // a permanent red `aura-job` target in /targets.
      if (newEnabled && newPort) {
        const probe = await fetch(`/api/clusters/${clusterId}/jobs/${jobId}/check-port`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ port: newPort }),
        });
        const pd = await probe.json().catch(() => ({}));
        if (!probe.ok || pd.ok === false) {
          setError({
            where: "save",
            status: probe.status,
            message: pd.reason ?? pd.error ?? `Probe failed (HTTP ${probe.status})`,
            raw: pd.probes ? JSON.stringify(pd.probes, null, 2) : undefined,
          });
          // Revert the local toggle so it visibly reflects the refused state.
          setEnabled(false);
          return;
        }
        if (pd.warning) {
          // 200 but body didn't look like Prometheus exposition — surface
          // a warning but still allow the save.
          setError({ where: "save", status: 0, message: pd.warning });
        }
      }

      const res = await fetch(`/api/clusters/${clusterId}/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metricsPort: newEnabled ? newPort : null }),
      });
      const text = await res.text();
      let parsed: { error?: string } = {};
      try { parsed = JSON.parse(text); } catch {}
      if (!res.ok) {
        setError({
          where: "save",
          status: res.status,
          message: parsed.error ?? `Save failed (HTTP ${res.status})`,
          raw: parsed.error ? undefined : text.slice(0, 4000),
        });
        return;
      }
      setSaveStatus(newEnabled ? "scraping" : "disabled");
      setRefreshing(true);
      try {
        const r2 = await fetch(`/api/clusters/${clusterId}/metrics/refresh-targets`, { method: "POST" });
        const t2 = await r2.text();
        let p2: { targets?: number; nodesScraped?: number; error?: string; detail?: string } = {};
        try { p2 = JSON.parse(t2); } catch {}
        if (!r2.ok) {
          setError({
            where: "refresh",
            status: r2.status,
            message: p2.error ?? `Refresh failed (HTTP ${r2.status})`,
            raw: p2.error ? undefined : t2.slice(0, 4000),
          });
        } else {
          setLastRefresh({ targets: p2.targets ?? 0, nodes: p2.nodesScraped ?? 0 });
        }
      } finally {
        setRefreshing(false);
      }
    } catch (e) {
      setError({ where: "save", status: 0, message: e instanceof Error ? e.message : "request failed" });
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    setEnabled(initialMetricsPort !== null);
    if (initialMetricsPort !== null) setPort(String(initialMetricsPort));
  }, [initialMetricsPort]);

  return (
    <div className="space-y-4">
      {!stack.loading && !stackReady && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
          {!stack.enabled ? (
            <>
              <p className="font-medium">Metrics stack isn&apos;t deployed for this cluster.</p>
              <p className="mt-1 text-xs">
                Ask an admin to open the cluster&apos;s <strong>Metrics</strong> tab and click
                <strong> Deploy</strong>. Until then this toggle is read-only — saving a port now
                would just give you a permanently-red Prometheus target.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">Prometheus isn&apos;t responding.</p>
              <p className="mt-1 text-xs">
                The stack is configured for this cluster but its Prometheus failed the readiness
                check (or the cluster controller can&apos;t reach it). Ask an admin to verify
                from the cluster&apos;s Metrics tab.
              </p>
            </>
          )}
        </div>
      )}

      <div className="rounded-md border bg-muted/30 p-4 text-sm space-y-2">
        <p className="font-medium">Expose Prometheus metrics</p>
        <p className="text-xs text-muted-foreground">
          When on, Aura tells the cluster&apos;s Prometheus to scrape{" "}
          <code className="rounded bg-muted px-1">&lt;node&gt;:&lt;port&gt;/metrics</code>{" "}
          on every node this job runs on. Works with anything that exposes
          a Prometheus-format <code>/metrics</code> endpoint — vLLM (default
          <code> 8000</code>), TorchServe, Triton, your own FastAPI app
          using <code>prometheus_client</code>, etc. The series land in
          Grafana under the <code>aura-job</code> job label, with{" "}
          <code>aura_jobid</code> / <code>slurm_jobid</code> / <code>user</code>{" "}
          labels for filtering.
        </p>
        <p className="text-xs text-muted-foreground">
          Requires the cluster&apos;s Prometheus + Grafana stack to be deployed
          (admin Metrics tab → Deploy). Until then this toggle persists but
          nothing scrapes it.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs">Enabled</Label>
          <div className="mt-1 flex h-10 items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={enabled}
              disabled={saving || !stackReady}
              // Local toggle only — nothing hits the server until the user
              // presses Save & refresh. Avoids a stray click mass-rebuilding
              // Prometheus targets every checkbox flip.
              onChange={(e) => { setEnabled(e.target.checked); setSaveStatus(null); }}
            />
            <span className="text-sm text-muted-foreground">
              {enabled ? "Will scrape on save" : "Off"}
              {enabled !== (initialMetricsPort !== null) && (
                <span className="ml-2 text-amber-700 dark:text-amber-400">unsaved</span>
              )}
            </span>
          </div>
        </div>
        <div className="w-32">
          <Label className="text-xs">Port</Label>
          <Input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => { setPort(e.target.value); setSaveStatus(null); }}
            disabled={!enabled || saving || !stackReady}
          />
        </div>
        {(() => {
          // Has the user changed anything since the last save?
          const dirty =
            enabled !== (initialMetricsPort !== null) ||
            (enabled && Number(port) !== (initialMetricsPort ?? -1));
          return (
            <Button
              variant="outline"
              onClick={() => {
                const p = Number(port);
                if (enabled && (!Number.isInteger(p) || p <= 0 || p >= 65536)) {
                  setError({ where: "save", status: 0, message: "Port must be 1-65535." });
                  return;
                }
                save(enabled, enabled ? p : null);
              }}
              disabled={saving || !dirty || !stackReady}
              title={
                !stackReady
                  ? "Cluster's Prometheus isn't running — admin must deploy the metrics stack first"
                  : dirty
                    ? "Persist this state and refresh Prometheus targets"
                    : "No unsaved changes"
              }
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save & refresh
            </Button>
          );
        })()}
        {saveStatus && !error && (
          <span
            className={
              "inline-flex h-9 items-center text-xs " +
              (saveStatus === "scraping"
                ? "text-green-700 dark:text-green-400"
                : "text-muted-foreground")
            }
          >
            {saveStatus === "scraping" ? "Saved — Prometheus will scrape this job." : "Saved — scrape disabled for this job."}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1 space-y-1">
              <p className="font-medium">
                {error.where === "save" ? "Couldn’t save the metrics port" : "Couldn’t refresh Prometheus targets"}
                {error.status ? <span className="ml-1 text-xs font-normal opacity-70">(HTTP {error.status})</span> : null}
              </p>
              <p className="text-sm">{error.message}</p>
              {error.raw && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs opacity-80">Server response</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-destructive/10 p-2 text-[11px]">{error.raw}</pre>
                </details>
              )}
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-xs underline-offset-4 opacity-80 hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {(refreshing || lastRefresh) && !error && (
        <div className="rounded-md border bg-muted/30 px-4 py-3 text-xs">
          {refreshing ? (
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Refreshing Prometheus file_sd targets…
            </span>
          ) : lastRefresh ? (
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <Badge variant="outline" className="bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-200">
                reloaded
              </Badge>
              Cluster now has <strong>{lastRefresh.targets}</strong> exposed-metrics
              job{lastRefresh.targets === 1 ? "" : "s"} totalling{" "}
              <strong>{lastRefresh.nodes}</strong> scrape target{lastRefresh.nodes === 1 ? "" : "s"}.
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
