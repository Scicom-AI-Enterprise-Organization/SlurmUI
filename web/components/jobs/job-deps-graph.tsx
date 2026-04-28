"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";

interface DepRef {
  slurmJobId: string;
  type: string;
  state?: string;
  name?: string;
  auraJobId?: string;
}

interface DepsResponse {
  self: { slurmJobId: string; state: string; name: string; auraJobId: string };
  parents: DepRef[];
  children: DepRef[];
  ok: boolean;
}

interface Props {
  clusterId: string;
  jobId: string;
}

/**
 * Render a job's local dependency DAG: parents → self → children.
 *
 * Slurm's --dependency= chains are ~always trees in practice (a job waits
 * on N parents, M downstream jobs wait on it), so we render three columns
 * instead of running a real graph layout. Parents come first with their
 * dep-type as the edge label (afterok, afterany, …). Children edge labels
 * are the type they used to depend on us.
 *
 * Each box shows the slurm id, name (when known), and a colored state
 * badge. When the slurm id maps to a SlurmUI Job we wrap the box in a
 * Link to that job's detail page.
 */
export function JobDepsGraph({ clusterId, jobId }: Props) {
  const [data, setData] = useState<DepsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/clusters/${clusterId}/jobs/${jobId}/deps`);
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setError(d?.error ?? `HTTP ${r.status}`);
        } else {
          setData(d);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "request failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clusterId, jobId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Resolving dependencies…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const isLeaf = data.parents.length === 0 && data.children.length === 0;
  if (isLeaf) {
    return (
      <div className="rounded-md border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        This job has no parents and no children — submit with{" "}
        <code className="rounded bg-muted px-1 text-xs">--dependency=afterok:&lt;jobid&gt;</code>{" "}
        to chain jobs together, then they&apos;ll show up here.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid items-start gap-4 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
        <Column title="Parents" empty="No upstream dependencies." refs={data.parents} clusterId={clusterId} edgeLabelMode="own" />
        <Connector visible={data.parents.length > 0} />
        <SelfColumn self={data.self} />
        <Connector visible={data.children.length > 0} />
        <Column title="Children" empty="No downstream jobs depending on this." refs={data.children} clusterId={clusterId} edgeLabelMode="own" />
      </div>
    </div>
  );
}

function Connector({ visible }: { visible: boolean }) {
  return (
    <div className="hidden h-full items-center justify-center pt-10 text-muted-foreground md:flex">
      {visible ? <ArrowRight className="h-5 w-5" /> : <span className="block w-5" />}
    </div>
  );
}

function Column({
  title, empty, refs, clusterId, edgeLabelMode,
}: { title: string; empty: string; refs: DepRef[]; clusterId: string; edgeLabelMode: "own" | "none" }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
      {refs.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {refs.map((r) => (
            <li key={r.slurmJobId}>
              <DepCard r={r} clusterId={clusterId} showEdgeType={edgeLabelMode === "own"} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SelfColumn({ self }: { self: DepsResponse["self"] }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">This job</h4>
      <div className="rounded-md border-2 border-primary/50 bg-primary/5 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-sm font-semibold">{self.slurmJobId}</span>
          <StateBadge state={self.state} />
        </div>
        {self.name && (
          <p className="mt-1 truncate text-xs text-muted-foreground" title={self.name}>{self.name}</p>
        )}
      </div>
    </div>
  );
}

function DepCard({ r, clusterId, showEdgeType }: { r: DepRef; clusterId: string; showEdgeType: boolean }) {
  const inner = (
    <div className="rounded-md border bg-card px-3 py-2 transition-colors hover:bg-muted">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm">{r.slurmJobId}</span>
        <StateBadge state={r.state} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate" title={r.name}>{r.name || "—"}</span>
        {showEdgeType && r.type && (
          <code className="shrink-0 rounded bg-muted px-1 text-[10px]">{r.type}</code>
        )}
      </div>
    </div>
  );
  if (r.auraJobId) {
    return (
      <Link href={`/clusters/${clusterId}/jobs/${r.auraJobId}`} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}

function StateBadge({ state }: { state?: string }) {
  if (!state) return <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">?</span>;
  const s = state.toUpperCase();
  const color =
    s === "RUNNING" ? "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200" :
    s === "PENDING" ? "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200" :
    s === "COMPLETED" ? "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200" :
    s === "FAILED" || s === "BOOT_FAIL" || s === "NODE_FAIL" || s === "OUT_OF_MEMORY" || s === "TIMEOUT" ? "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200" :
    s === "CANCELLED" ? "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-200" :
    "bg-muted text-muted-foreground";
  return <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${color}`}>{s}</span>;
}
