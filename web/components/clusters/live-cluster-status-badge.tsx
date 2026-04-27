"use client";

import { useEffect, useState } from "react";
import { ClusterStatusBadge } from "./cluster-status-badge";

interface Health {
  lastProbeAt?: string;
  alive?: boolean;
  message?: string;
  failStreak?: number;
}

type Status = "PROVISIONING" | "ACTIVE" | "DEGRADED" | "OFFLINE";

interface Props {
  clusterId: string;
  initialStatus: Status;
  initialHealth?: Health | null;
}

/**
 * Same render as <ClusterStatusBadge> but kept in sync with the live SSH
 * liveness probe via a 10s poll of /api/clusters/[id]. The plain badge
 * reads cluster.status from the DB at SSR time, which lags the probe by
 * a cycle — that's why the page header would show OFFLINE while the
 * status card showed ACTIVE. Mirrors the derivation logic in
 * ClusterStatusCard so the two always agree.
 */
export function LiveClusterStatusBadge({ clusterId, initialStatus, initialHealth = null }: Props) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [health, setHealth] = useState<Health | null>(initialHealth);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`/api/clusters/${clusterId}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          if (d?.status) setStatus(d.status as Status);
          const h = (d?.config?.health as Health | undefined) ?? null;
          if (h) setHealth(h);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [clusterId]);

  const effective: Status =
    status === "PROVISIONING"
      ? "PROVISIONING"
      : health?.alive === true
        ? "ACTIVE"
        : health?.alive === false
          ? "OFFLINE"
          : status;

  return <ClusterStatusBadge status={effective} />;
}
