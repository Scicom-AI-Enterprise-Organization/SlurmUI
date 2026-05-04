"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { JobStatusBadge } from "@/components/jobs/job-status-badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ExternalLink, RefreshCw, Globe, Trash2, Loader2, Copy } from "lucide-react";
import { toast } from "sonner";

interface ProxyItem {
  id: string;
  slurmJobId: number | null;
  jobName: string;
  partition: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  proxyPort: number;
  proxyName: string | null;
  proxyPublic: boolean;
  createdAt: string;
  updatedAt: string;
  user: { id: string; email: string; name: string | null; unixUsername: string | null } | null;
}

export default function ProxiesPage() {
  const { id } = useParams<{ id: string }>();
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProxyItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Per-card toggle for the public/private flag. Optimistic update so
  // the switch flips immediately; the periodic refetch will reconcile
  // if the PATCH actually fails.
  const togglePublic = async (item: ProxyItem, makePublic: boolean) => {
    setProxies((prev) => prev.map((p) => (p.id === item.id ? { ...p, proxyPublic: makePublic } : p)));
    try {
      const res = await fetch(`/api/clusters/${id}/jobs/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyPublic: makePublic }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error("Couldn't update public access", { description: d.error ?? `HTTP ${res.status}` });
        // Roll back the optimistic flip.
        setProxies((prev) => prev.map((p) => (p.id === item.id ? { ...p, proxyPublic: !makePublic } : p)));
      }
    } catch (e) {
      toast.error("Couldn't update public access", { description: e instanceof Error ? e.message : "Network error" });
      setProxies((prev) => prev.map((p) => (p.id === item.id ? { ...p, proxyPublic: !makePublic } : p)));
    }
  };

  const removeProxy = async (item: ProxyItem) => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/clusters/${id}/jobs/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyPort: null, proxyName: null }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error("Couldn't remove proxy", {
          description: d.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setConfirmDelete(null);
      await fetchProxies();
    } catch (e) {
      toast.error("Couldn't remove proxy", {
        description: e instanceof Error ? e.message : "Network error",
      });
    } finally {
      setDeleting(false);
    }
  };

  const fetchProxies = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/clusters/${id}/proxies`);
      const d = await res.json();
      if (!res.ok) {
        setError(d.error ?? `HTTP ${res.status}`);
        setProxies([]);
        return;
      }
      setProxies(d.proxies ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProxies(); }, [id]);

  // Auto-refresh every 10s so a job flipping to RUNNING shows up without
  // the user having to click around. Lightweight read; no SSH involved.
  useEffect(() => {
    const t = setInterval(fetchProxies, 10000);
    return () => clearInterval(t);
  }, [id]);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const running = proxies.filter((p) => p.status === "RUNNING");
  const other = proxies.filter((p) => p.status !== "RUNNING");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Proxies</h1>
          <p className="text-sm text-muted-foreground">
            Per-job HTTP/WebSocket reverse proxies. Set a port on a job&apos;s{" "}
            <strong>Proxy</strong> tab to expose it here.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchProxies} disabled={loading}>
          <RefreshCw className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && proxies.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-16 text-center text-muted-foreground gap-3">
          <Globe className="h-10 w-10 opacity-40" />
          <p className="text-base font-medium">No proxies configured</p>
          <p className="max-w-md text-sm">
            Open a job&apos;s detail page and use the <strong>Proxy</strong> tab to expose its
            HTTP/WebSocket service through Aura. Useful for Jupyter, TensorBoard, MLflow,
            Streamlit, custom FastAPI/Flask apps — anything that speaks HTTP on a known port.
          </p>
        </div>
      )}

      {running.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Running ({running.length})
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {running.map((p) => (
              <ProxyCard
                key={p.id}
                clusterId={id}
                item={p}
                origin={origin}
                onDelete={() => setConfirmDelete(p)}
                onTogglePublic={(makePublic) => togglePublic(p, makePublic)}
              />
            ))}
          </div>
        </section>
      )}

      {other.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Inactive ({other.length})
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {other.map((p) => (
              <ProxyCard
                key={p.id}
                clusterId={id}
                item={p}
                origin={origin}
                onDelete={() => setConfirmDelete(p)}
                onTogglePublic={(makePublic) => togglePublic(p, makePublic)}
              />
            ))}
          </div>
        </section>
      )}

      <Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o && !deleting) setConfirmDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove proxy?</DialogTitle>
            <DialogDescription>
              Clears the proxy port from{" "}
              <span className="font-medium text-foreground">
                {confirmDelete?.proxyName || confirmDelete?.jobName}
              </span>
              . The job itself keeps running — only the{" "}
              <code className="rounded bg-muted px-1">/job-proxy/&hellip;</code> URL will stop
              working. You can re-enable it from the job&apos;s Proxy tab.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && removeProxy(confirmDelete)}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Remove proxy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProxyCard({
  clusterId,
  item,
  origin,
  onDelete,
  onTogglePublic,
}: {
  clusterId: string;
  item: ProxyItem;
  origin: string;
  onDelete: () => void;
  onTogglePublic: (makePublic: boolean) => void;
}) {
  const url = `${origin}/job-proxy/${clusterId}/${item.id}/`;
  const isRunning = item.status === "RUNNING";
  // Per-card flag — separate copy state so multiple cards on the same
  // page don't all flash "Copied" when one is clicked.
  const [copied, setCopied] = useState(false);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <Link
            href={`/clusters/${clusterId}/jobs/${item.id}`}
            className="hover:underline truncate"
            title={item.jobName}
          >
            {item.jobName}
          </Link>
          <JobStatusBadge status={item.status} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {item.proxyName && (
            <Badge variant="secondary" className="font-normal">
              {item.proxyName}
            </Badge>
          )}
          <Badge variant="outline" className="font-mono">
            :{item.proxyPort}
          </Badge>
          {item.proxyPublic && (
            <Badge className="bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
              Public
            </Badge>
          )}
          <span>partition {item.partition}</span>
          {item.slurmJobId !== null && <span>Slurm {item.slurmJobId}</span>}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="h-3.5 w-3.5"
            checked={item.proxyPublic}
            onChange={(e) => onTogglePublic(e.target.checked)}
          />
          <span>
            Public access — anyone with the URL can use this proxy without an Aura account
          </span>
        </label>
        {item.user && (
          <p className="text-xs text-muted-foreground">
            Submitted by{" "}
            <span className="font-medium text-foreground">
              {item.user.name || item.user.unixUsername || item.user.email}
            </span>
          </p>
        )}
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
            {url}
          </code>
          {/* Copy URL — same floating "Copied" popover pattern as the
              admin Metrics tab + the Job Proxy tab. */}
          <span className="relative inline-flex">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              title="Copy URL"
              onClick={() => {
                navigator.clipboard.writeText(url);
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
          {isRunning ? (
            <a href={url} target="_blank" rel="noopener noreferrer" title="Open proxy">
              <Button size="icon" variant="ghost" className="h-8 w-8">
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </a>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              disabled
              title="Job isn't running — proxy will return 502"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            title="Remove proxy (keeps the job running)"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
