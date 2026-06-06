"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const tabs = [
  { slug: "configuration", label: "Configuration", requiresActive: false },
  { slug: "ssh", label: "SSH", requiresActive: false },
  { slug: "nodes", label: "Nodes", requiresActive: true },
  { slug: "partitions", label: "Partitions", requiresActive: true },
  { slug: "storage", label: "Storages", requiresActive: true },
  { slug: "packages", label: "Packages", requiresActive: true },
  { slug: "python", label: "Python", requiresActive: true },
  { slug: "environment", label: "Environment", requiresActive: true },
  { slug: "users", label: "Users", requiresActive: true },
  { slug: "queue", label: "Queue", requiresActive: true },
  { slug: "reservations", label: "Reservations", requiresActive: true },
  { slug: "qos", label: "QoS", requiresActive: true },
  { slug: "metrics", label: "Metrics", requiresActive: true },
  { slug: "integrations", label: "Integrations", requiresActive: true },
];

interface Health {
  alive?: boolean;
}

interface ClusterTabsProps {
  clusterId: string;
  isActive: boolean;
  // Single-node RunPod instant clusters: these multi-node-only tabs (Storages =
  // cross-node NFS, Reservations = node-subset gating) stay VISIBLE but are
  // unclickable, with a tooltip explaining why.
  instant?: boolean;
}

// Tabs that don't apply on a single-node instant cluster — shown disabled.
const INSTANT_BLOCKED = new Set(["storage", "reservations"]);

export function ClusterTabs({ clusterId, isActive: initialIsActive, instant = false }: ClusterTabsProps) {
  const pathname = usePathname();
  const base = `/admin/clusters/${clusterId}`;
  // SSR seeds isActive from cluster.status; the DB column lags the live SSH
  // probe by a cycle, so without polling the user sees disabled tabs even
  // after the cluster comes back ACTIVE. Mirror the same probe-derived
  // logic ClusterStatusCard uses so the tabs unlock immediately when the
  // probe goes green.
  const [clusterIsActive, setClusterIsActive] = useState(initialIsActive);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`/api/clusters/${clusterId}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          const status = d?.status as string | undefined;
          const health = (d?.config?.health as Health | undefined) ?? null;
          if (status === "PROVISIONING") {
            setClusterIsActive(false);
            return;
          }
          if (health?.alive === true) setClusterIsActive(true);
          else if (health?.alive === false) setClusterIsActive(false);
          else if (status) setClusterIsActive(status === "ACTIVE");
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [clusterId]);

  return (
    <div className="flex gap-1 border-b">
      {tabs.map((tab) => {
        const href = `${base}/${tab.slug}`;
        const isActive = pathname === href || pathname.startsWith(href + "/");
        const instantBlocked = instant && INSTANT_BLOCKED.has(tab.slug);
        const disabled = (tab.requiresActive && !clusterIsActive) || instantBlocked;

        if (disabled) {
          return (
            <span
              key={tab.slug}
              className="relative px-4 py-2 text-sm font-medium text-muted-foreground/40 cursor-not-allowed"
              title={instantBlocked ? "Not available in RunPod instant cluster" : "Bootstrap the cluster first"}
            >
              {tab.label}
            </span>
          );
        }

        return (
          <Link
            key={tab.slug}
            href={href}
            className={cn(
              "relative px-4 py-2 text-sm font-medium transition-colors rounded-t-md",
              isActive
                ? "text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
