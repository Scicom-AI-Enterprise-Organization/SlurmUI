"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClusterStatusBadge } from "@/components/clusters/cluster-status-badge";
import { Server, ChevronDown, ChevronRight } from "lucide-react";

interface Health {
  lastProbeAt?: string;
  alive?: boolean;
  message?: string;
  failStreak?: number;
}

interface Props {
  clusterId: string;
  initialStatus: "PROVISIONING" | "ACTIVE" | "DEGRADED" | "OFFLINE";
  initialHealth: Health | null;
}

export function ClusterStatusCard({ clusterId, initialStatus, initialHealth }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [health, setHealth] = useState<Health | null>(initialHealth);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // GET /api/clusters/[id] serves the latest DB state AND asynchronously
    // kicks off the debounced SSH liveness probe. The probe lands a few
    // seconds later, so a single GET returns stale data. Poll periodically
    // so the probe's write ("status flipped back to ACTIVE") shows up
    // without the user having to hard-refresh several times.
    let cancelled = false;
    const load = () =>
      fetch(`/api/clusters/${clusterId}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          if (d?.status) setStatus(d.status);
          const h = (d?.config?.health as Health | undefined) ?? null;
          if (h) setHealth(h);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [clusterId]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Status</CardTitle>
        <Server className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2">
          {/* Derive the badge from the latest probe when we have one — the
              DB's cluster.status is updated lazily and can lag behind the
              probe result by a cycle. PROVISIONING always wins because it
              means bootstrap is in flight (probe isn't authoritative). */}
          <ClusterStatusBadge
            status={
              status === "PROVISIONING"
                ? "PROVISIONING"
                : health?.alive === true
                ? "ACTIVE"
                : health?.alive === false
                ? "OFFLINE"
                : status
            }
          />
          {health?.lastProbeAt && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="inline-flex items-center rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/60"
              title={open ? "Hide probe details" : "Show probe details"}
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <span className="ml-0.5">details</span>
            </button>
          )}
        </div>
        {!health?.lastProbeAt && (
          <div className="text-[11px] text-muted-foreground">
            Waiting for the first liveness probe…
          </div>
        )}
        {open && health?.lastProbeAt && (
          <div className="rounded-md border bg-muted/30 p-2 text-[11px] font-mono space-y-0.5">
            <div suppressHydrationWarning>
              last probe: {new Date(health.lastProbeAt).toLocaleString()}
            </div>
            <div>
              result:{" "}
              <span className={health.alive ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
                {health.alive ? "alive" : "failed"}
              </span>
            </div>
            {health.message && health.message !== "alive" && (
              <div className="break-all">message: {health.message}</div>
            )}
            {typeof health.failStreak === "number" && health.failStreak > 0 && (
              <div>fail streak: {health.failStreak}</div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
