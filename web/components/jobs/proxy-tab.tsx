"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Save, ExternalLink, AlertCircle, Copy } from "lucide-react";

interface Props {
  clusterId: string;
  jobId: string;
  initialProxyPort: number | null;
  initialProxyName: string | null;
  initialProxyPublic: boolean;
  jobStatus: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
}

/**
 * Per-job toggle for "reverse-proxy this job's HTTP+WebSocket service
 * through Aura". Generic — works for Jupyter, TensorBoard, MLflow, Streamlit,
 * any HTTP/WS service that runs on a known port on the job's node.
 *
 * On save the URL becomes /job-proxy/<clusterId>/<jobId>/. The user is
 * expected to configure their service with that base URL (e.g. Jupyter's
 * --ServerApp.base_url=...) so its emitted absolute links round-trip
 * through the proxy correctly.
 */
export function ProxyTab({ clusterId, jobId, initialProxyPort, initialProxyName, initialProxyPublic, jobStatus }: Props) {
  const [enabled, setEnabled] = useState(initialProxyPort !== null);
  const [port, setPort] = useState<string>(
    initialProxyPort !== null ? String(initialProxyPort) : "8888",
  );
  const [name, setName] = useState<string>(initialProxyName ?? "");
  const [isPublic, setIsPublic] = useState(initialProxyPublic);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "disabled" | null>(null);
  const [error, setError] = useState<{ status: number; message: string; raw?: string } | null>(null);
  // Brief Copy → Check icon swap so the user has visual confirmation
  // independent of the toast.
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setEnabled(initialProxyPort !== null);
    if (initialProxyPort !== null) setPort(String(initialProxyPort));
    setName(initialProxyName ?? "");
    setIsPublic(initialProxyPublic);
  }, [initialProxyPort, initialProxyName, initialProxyPublic]);

  const proxyUrl = typeof window !== "undefined"
    ? `${window.location.origin}/job-proxy/${clusterId}/${jobId}/`
    : `/job-proxy/${clusterId}/${jobId}/`;

  const save = async (newEnabled: boolean, newPort: number | null, newName: string | null, newPublic: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proxyPort: newEnabled ? newPort : null,
          proxyName: newEnabled ? (newName ?? null) : null,
          // proxyPublic is independent — make it sticky even when the
          // proxy is disabled so flipping the proxy back on doesn't lose
          // the prior public/private choice. (We could clear it on
          // disable, but admins find that surprising.)
          proxyPublic: newEnabled ? newPublic : false,
        }),
      });
      const text = await res.text();
      let parsed: { error?: string } = {};
      try { parsed = JSON.parse(text); } catch {}
      if (!res.ok) {
        setError({
          status: res.status,
          message: parsed.error ?? `Save failed (HTTP ${res.status})`,
          raw: parsed.error ? undefined : text.slice(0, 4000),
        });
        return;
      }
      setSaveStatus(newEnabled ? "saved" : "disabled");
    } catch (e) {
      setError({ status: 0, message: e instanceof Error ? e.message : "request failed" });
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    enabled !== (initialProxyPort !== null) ||
    (enabled && Number(port) !== (initialProxyPort ?? -1)) ||
    (enabled && name !== (initialProxyName ?? "")) ||
    (enabled && isPublic !== initialProxyPublic);

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-muted/30 p-4 text-sm space-y-2">
        <p className="font-medium">Reverse-proxy this job&apos;s HTTP service</p>
        <p className="text-xs text-muted-foreground">
          When on, Aura forwards{" "}
          <code className="rounded bg-muted px-1">/job-proxy/&lt;cluster&gt;/&lt;job&gt;/*</code>{" "}
          to <code className="rounded bg-muted px-1">&lt;node&gt;:&lt;port&gt;</code> on the
          node this job runs on, going through the cluster controller via SSH (workers are
          private). HTTP and WebSocket both work — vLLM, Jupyter, TensorBoard, MLflow,
          Streamlit, your own FastAPI / Flask app, etc.
        </p>
        <p className="text-xs text-muted-foreground">
          The proxy <strong>strips its prefix</strong> before forwarding upstream — so{" "}
          <code className="rounded bg-muted px-1">/job-proxy/&lt;cluster&gt;/&lt;job&gt;/docs</code>{" "}
          arrives at your service as <code className="rounded bg-muted px-1">/docs</code>.
          The header <code className="rounded bg-muted px-1">X-Forwarded-Prefix</code> is set
          so prefix-aware frameworks (FastAPI <code>root_path</code>, etc.) can still emit
          correctly-prefixed absolute links.
        </p>
        <p className="text-xs text-muted-foreground">
          Best results when your service emits relative URLs or supports
          <code className="mx-1 rounded bg-muted px-1">X-Forwarded-Prefix</code>. Services
          that hard-code absolute paths in HTML (older Jupyter, TensorBoard) will need a
          base-URL flag — those links bypass the proxy otherwise.
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
              disabled={saving}
              onChange={(e) => { setEnabled(e.target.checked); setSaveStatus(null); }}
            />
            <span className="text-sm text-muted-foreground">
              {enabled ? "Will proxy on save" : "Off"}
              {dirty && <span className="ml-2 text-amber-700 dark:text-amber-400">unsaved</span>}
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
            disabled={!enabled || saving}
          />
        </div>
        <div className="min-w-48 flex-1">
          <Label className="text-xs">Label (optional)</Label>
          <Input
            type="text"
            placeholder="e.g. Jupyter, TensorBoard"
            value={name}
            maxLength={64}
            onChange={(e) => { setName(e.target.value); setSaveStatus(null); }}
            disabled={!enabled || saving}
          />
        </div>
        <div>
          <Label className="text-xs">Access</Label>
          <label className="mt-1 flex h-10 cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={isPublic}
              disabled={!enabled || saving}
              onChange={(e) => { setIsPublic(e.target.checked); setSaveStatus(null); }}
            />
            <span className="text-sm">
              <span className="font-medium">Public</span>{" "}
              <span className="text-muted-foreground">
                — anyone with the URL can use this proxy without an Aura account.
                Off by default; sign-in is required.
              </span>
            </span>
          </label>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            const p = Number(port);
            if (enabled && (!Number.isInteger(p) || p <= 0 || p >= 65536)) {
              setError({ status: 0, message: "Port must be 1-65535." });
              return;
            }
            save(enabled, enabled ? p : null, enabled ? (name.trim() || null) : null, isPublic);
          }}
          disabled={saving || !dirty}
          title={dirty ? "Persist this state" : "No unsaved changes"}
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save
        </Button>
        {saveStatus && !error && (
          <span
            className={
              "inline-flex h-9 items-center text-xs " +
              (saveStatus === "saved" ? "text-green-700 dark:text-green-400" : "text-muted-foreground")
            }
          >
            {saveStatus === "saved" ? "Saved." : "Saved — proxy disabled."}
          </span>
        )}
      </div>

      {initialProxyPort !== null && (
        <div className="rounded-md border bg-muted/30 p-4 text-sm space-y-2">
          <div className="flex items-center justify-between">
            <p className="font-medium">Proxy URL</p>
            {jobStatus === "RUNNING" ? (
              <a href={proxyUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="default" size="sm">
                  <ExternalLink className="mr-2 h-3 w-3" />
                  Open
                </Button>
              </a>
            ) : (
              <span className="text-xs text-muted-foreground">
                Job is {jobStatus} — proxy active only while RUNNING
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs break-all">
              {proxyUrl}
            </code>
            {/* Copy + floating "Copied" popover, mirroring the
                /admin/clusters/<id>/metrics grafana password UX. */}
            <span className="relative inline-flex">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                title="Copy URL"
                onClick={() => {
                  navigator.clipboard.writeText(proxyUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
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
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1 space-y-1">
              <p className="font-medium">
                Couldn&apos;t save the proxy port
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
    </div>
  );
}
