"use client";

import { useEffect, useRef, useState } from "react";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { useParams, useSearchParams, useRouter, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { JobTable } from "@/components/jobs/job-table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TemplatesPanel } from "@/components/jobs/templates-panel";
import { toast } from "sonner";
import { Plus, ChevronLeft, ChevronRight, Eraser, Loader2, Cpu, MemoryStick, Gpu, RefreshCw, Download } from "lucide-react";
import Link from "next/link";

interface NodeResource {
  host: string;
  state: string;
  cpuAlloc: number;
  cpuTotal: number;
  memTotalMb: number;
  memFreeMb: number;
  gpuTotal: number;
  gpuUsed: number;
}

interface ClusterResources {
  totals: {
    cpuTotal: number; cpuFree: number;
    memTotalMb: number; memFreeMb: number;
    gpuTotal: number; gpuFree: number;
  };
  nodes: NodeResource[];
  fetchedAt: string;
}

function isLive(state: string): boolean {
  const x = state.toLowerCase();
  return !x.includes("down") && !x.includes("drain") && !x.includes("fail") &&
    !x.includes("maint") && !x.includes("boot");
}

function ResourceColumn({
  icon, label, unit, free, total, nodes, getFree, getTotal,
}: {
  icon: React.ReactNode;
  label: string;
  unit: string;
  free: number;
  total: number;
  nodes: NodeResource[];
  getFree: (n: NodeResource) => number;
  getTotal: (n: NodeResource) => number;
}) {
  const pct = total > 0 ? Math.round((free / total) * 100) : 0;
  const low = pct < 15;
  const sorted = [...nodes].sort((a, b) => getFree(b) - getFree(a));
  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 font-medium">{icon}{label}</span>
          <span className="font-mono">
            <span className={low ? "text-destructive font-semibold" : ""}>{free.toLocaleString()}</span>
            <span className="text-muted-foreground"> / {total.toLocaleString()} {unit}</span>
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
          <div className={`h-full transition-all ${low ? "bg-destructive" : "bg-primary"}`}
            style={{ width: `${pct}%` }} />
        </div>
      </div>
      {sorted.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No nodes.</p>
      ) : (
        <ul className="space-y-1 text-[11px]">
          {sorted.map((n) => {
            const nFree = getFree(n);
            const nTotal = getTotal(n);
            const live = isLive(n.state);
            return (
              <li key={n.host} className="flex items-center justify-between gap-2">
                <span className={`truncate font-mono ${live ? "" : "text-muted-foreground line-through"}`}
                  title={live ? n.state : `${n.state} — not schedulable`}>
                  {n.host}
                </span>
                <span className="font-mono">
                  <span className={nFree === 0 ? "text-muted-foreground" : ""}>{nFree}</span>
                  <span className="text-muted-foreground"> / {nTotal}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ClusterResourcePanel({ clusterId }: { clusterId: string }) {
  const [data, setData] = useState<ClusterResources | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debug, setDebug] = useState<{ jobs: string; nodes: string; squeue: string; conf: string; fetchedAt: string } | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugErr, setDebugErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/resources`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setData(d);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  const loadDebug = async () => {
    setDebugLoading(true);
    setDebugErr(null);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/alloc-debug`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setDebug(d);
    } catch (e) {
      setDebugErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setDebugLoading(false);
    }
  };

  // Auto-refresh resources every 30 s while the tab is visible. The
  // /resources endpoint does a live SSH + sinfo on the controller, which
  // is the slowest endpoint on this page — running it for a tab nobody
  // is looking at is pure waste. Visibility-aware interval also fires
  // immediately on mount and on visibility-resume so the user sees
  // fresh data when they come back.
  useVisibleInterval(load, 30_000);

  // First time the debug panel is expanded, fetch. Subsequent expansions
  // reuse the last payload until the user hits Refresh.
  useEffect(() => {
    if (debugOpen && !debug && !debugLoading) loadDebug();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugOpen]);

  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Cluster resources</p>
          {data && (
            <p className="text-xs text-muted-foreground">
              {data.nodes.length} node{data.nodes.length === 1 ? "" : "s"} · updated {new Date(data.fetchedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      {data && (
        <div className="grid gap-4 md:grid-cols-3">
          <ResourceColumn
            icon={<Cpu className="h-3 w-3" />} label="CPU" unit="cores"
            free={data.totals.cpuFree} total={data.totals.cpuTotal}
            nodes={data.nodes}
            getFree={(n) => (isLive(n.state) ? Math.max(0, n.cpuTotal - n.cpuAlloc) : 0)}
            getTotal={(n) => n.cpuTotal}
          />
          <ResourceColumn
            icon={<MemoryStick className="h-3 w-3" />} label="Memory" unit="GiB"
            free={Math.round(data.totals.memFreeMb / 1024)}
            total={Math.round(data.totals.memTotalMb / 1024)}
            nodes={data.nodes}
            getFree={(n) => (isLive(n.state) ? Math.round(n.memFreeMb / 1024) : 0)}
            getTotal={(n) => Math.round(n.memTotalMb / 1024)}
          />
          <ResourceColumn
            icon={<Gpu className="h-3 w-3" />} label="GPU" unit="GPUs"
            free={data.totals.gpuFree} total={data.totals.gpuTotal}
            nodes={data.nodes.filter((n) => n.gpuTotal > 0)}
            getFree={(n) => (isLive(n.state) ? Math.max(0, n.gpuTotal - n.gpuUsed) : 0)}
            getTotal={(n) => n.gpuTotal}
          />
        </div>
      )}

      {/* "Why is X allocated?" diagnostic — runs scontrol show job -dd,
          scontrol show node, squeue with CPU column, and greps slurm.conf
          for SelectType/Partition/NodeName. Cheap for small clusters,
          collapsed by default to keep the panel tidy. */}
      {data && (
        <div className="rounded-md border bg-muted/30">
          <button
            type="button"
            onClick={() => setDebugOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-mono hover:bg-muted"
          >
            <span>
              <span className="mr-2 text-muted-foreground">{debugOpen ? "▾" : "▸"}</span>
              Why is CPU / GPU / memory showing as allocated?
            </span>
            {debugOpen && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => { e.stopPropagation(); loadDebug(); }}
                disabled={debugLoading}
                className="h-6 px-2"
              >
                <RefreshCw className={`h-3 w-3 ${debugLoading ? "animate-spin" : ""}`} />
              </Button>
            )}
          </button>
          {debugOpen && (
            <div className="space-y-3 border-t px-3 py-3 font-mono text-xs">
              {debugErr && <p className="text-destructive">{debugErr}</p>}
              {debugLoading && !debug && <p className="text-muted-foreground">Running scontrol / squeue on the controller…</p>}
              {debug && (
                <>
                  <div className="text-muted-foreground">
                    Fetched {new Date(debug.fetchedAt).toLocaleTimeString()}. Compare <code>AllocCPUs</code> / <code>AllocTRES</code> in the node dump with the <code>%C</code> column (CPUs) in squeue — if node &gt; sum(jobs), Slurm is rounding up to whole cores because of <code>CR_Core_Memory</code>.
                  </div>

                  <div>
                    <div className="mb-1 text-muted-foreground">slurm.conf (SelectType / Partition / NodeName)</div>
                    <pre className="max-h-40 overflow-auto rounded border bg-background p-2">{debug.conf || "(empty)"}</pre>
                  </div>

                  <div>
                    <div className="mb-1 text-muted-foreground">squeue — %T STATE · %C CPUs · %m MinMem (MB) · %b TresPerNode (gres:gpu:N)</div>
                    <pre className="max-h-40 overflow-auto rounded border bg-background p-2">{debug.squeue || "(no running / pending jobs)"}</pre>
                  </div>

                  <div>
                    <div className="mb-1 text-muted-foreground">scontrol show node — CPUAlloc, AllocTRES</div>
                    <pre className="max-h-72 overflow-auto rounded border bg-background p-2">{debug.nodes || "(no nodes)"}</pre>
                  </div>

                  <div>
                    <div className="mb-1 text-muted-foreground">scontrol show job -dd — NumCPUs, MinCPUsNode, Gres</div>
                    <pre className="max-h-72 overflow-auto rounded border bg-background p-2">{debug.jobs || "(no active jobs)"}</pre>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface Job {
  id: string;
  slurmJobId: number | null;
  clusterId: string;
  partition: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  createdAt: string;
  name?: string | null;
}

const STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

const PAGE_SIZES = [10, 20, 50, 100];

// `initialData` is the page-1 / no-filters jobs payload pre-fetched by
// the server component. When the URL has no filters, the client renders
// the table on first paint without a fetch waterfall. With filters, the
// existing filter-change effect re-fetches with the right query.
export interface JobListInitialData {
  jobs: Job[];
  pagination: Pagination;
  partitions: string[];
}

export default function JobListPage({ initialData }: { initialData?: JobListInitialData }) {
  const params = useParams();
  const clusterId = params.id as string;
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Initialize state from URL so the page is shareable/bookmarkable and
  // filter state survives refresh. When the URL is in default state and
  // we got `initialData` from the server, seed the table from it so the
  // first paint already has rows — saves a round-trip on cold loads.
  const urlIsDefault =
    !searchParams.get("name") &&
    !searchParams.get("status") &&
    !searchParams.get("partition") &&
    !searchParams.get("from") &&
    !searchParams.get("to") &&
    (searchParams.get("page") === null || searchParams.get("page") === "1") &&
    (searchParams.get("limit") === null || searchParams.get("limit") === "20");
  const seedJobs = urlIsDefault && initialData ? initialData.jobs : [];
  const seedPagination = urlIsDefault && initialData
    ? initialData.pagination
    : { page: 1, limit: 20, total: 0, pages: 1 };
  const seedPartitions = initialData?.partitions ?? [];

  const [jobs, setJobs] = useState<Job[]>(seedJobs);
  const [loading, setLoading] = useState(seedJobs.length === 0);
  const [page, setPage] = useState(() => parseInt(searchParams.get("page") ?? "1") || 1);
  const [limit, setLimit] = useState(() => parseInt(searchParams.get("limit") ?? "20") || 20);
  const [pagination, setPagination] = useState<Pagination>(seedPagination);

  const [nameFilter, setNameFilter] = useState(() => searchParams.get("name") ?? "");
  const [debouncedName, setDebouncedName] = useState(() => searchParams.get("name") ?? "");
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get("status") ?? "");
  const [partitionFilter, setPartitionFilter] = useState(() => searchParams.get("partition") ?? "");
  const [partitions, setPartitions] = useState<string[]>(seedPartitions);
  const [fromDate, setFromDate] = useState(() => searchParams.get("from") ?? "");
  const [toDate, setToDate] = useState(() => searchParams.get("to") ?? "");

  // Debounce name input so every keystroke doesn't hit the API.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedName(nameFilter), 300);
    return () => clearTimeout(t);
  }, [nameFilter]);

  // Reset to page 1 whenever a filter changes (otherwise current page may be empty).
  useEffect(() => {
    setPage(1);
  }, [debouncedName, statusFilter, partitionFilter, fromDate, toDate]);

  // Reflect state → URL so filters are shareable/back-navigable.
  useEffect(() => {
    const qs = new URLSearchParams();
    if (debouncedName) qs.set("name", debouncedName);
    if (statusFilter) qs.set("status", statusFilter);
    if (partitionFilter) qs.set("partition", partitionFilter);
    if (fromDate) qs.set("from", fromDate);
    if (toDate) qs.set("to", toDate);
    if (page > 1) qs.set("page", String(page));
    if (limit !== 20) qs.set("limit", String(limit));
    const qsStr = qs.toString();
    router.replace(qsStr ? `${pathname}?${qsStr}` : pathname, { scroll: false });
  }, [debouncedName, statusFilter, partitionFilter, fromDate, toDate, page, limit, pathname, router]);

  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<{ ok: boolean; output: string; count?: number } | null>(null);

  // Per-cluster GitOps-only flag. When true, hide the Submit Job button and
  // show a banner explaining that manifests must land in the repo instead.
  const [gitopsOnly, setGitopsOnly] = useState(false);
  useEffect(() => {
    fetch(`/api/clusters/${clusterId}/gitops-only`)
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d) => setGitopsOnly(!!d.enabled))
      .catch(() => {});
  }, [clusterId]);

  const fetchJobs = () => {
    setLoading(true);
    const qs = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    if (debouncedName) qs.set("name", debouncedName);
    if (statusFilter) qs.set("status", statusFilter);
    if (partitionFilter) qs.set("partition", partitionFilter);
    if (fromDate) qs.set("from", fromDate);
    if (toDate) qs.set("to", toDate);

    fetch(`/api/clusters/${clusterId}/jobs?${qs.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        setJobs(data.jobs ?? []);
        setPagination(data.pagination ?? { page: 1, limit, total: 0, pages: 1 });
        setPartitions(data.partitions ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  // Skip the very first mount fetch when the server-component seed
  // already covers the request (URL is in default state). Without this
  // skip, the page paid for two parallel Prisma stacks per load — the
  // server pre-fetch then an immediate identical client fetch — which
  // doubled DB pressure and Node heap. After the first run the ref
  // flips and the effect behaves normally on filter changes.
  const skipFirstFetchRef = useRef(urlIsDefault && initialData != null);
  useEffect(() => {
    if (skipFirstFetchRef.current) {
      skipFirstFetchRef.current = false;
      return;
    }
    fetchJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, page, limit, debouncedName, statusFilter, partitionFilter, fromDate, toDate]);

  const hasFilters = !!(nameFilter || statusFilter || partitionFilter || fromDate || toDate);
  const clearFilters = () => {
    setNameFilter("");
    setStatusFilter("");
    setPartitionFilter("");
    setFromDate("");
    setToDate("");
  };

  const rangeStart = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
  const rangeEnd = Math.min(pagination.page * pagination.limit, pagination.total);

  const handleReset = async () => {
    setConfirmReset(false);
    setResetting(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs/reset-queue`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setResetResult({ ok: true, output: data.output ?? "", count: data.dbCancelled });
        fetchJobs();
      } else {
        setResetResult({ ok: false, output: data.error ?? `Server returned ${res.status}` });
      }
    } catch (e) {
      setResetResult({
        ok: false,
        output: e instanceof Error ? e.message : "Network error",
      });
    } finally {
      setResetting(false);
    }
  };

  const pendingCount = jobs.filter((j) => j.status === "PENDING").length;

  // Admin-only: import jobs from Slurm's live queue into the DB. Handy when
  // the DB is empty vs Slurm (fresh install, migration, CLI-submitted jobs).
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ ok: boolean; summary: string; details?: string } | null>(null);
  const handleImport = async () => {
    setImporting(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs/import-from-slurm`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setImportResult({ ok: false, summary: d.error ?? `HTTP ${res.status}` });
        return;
      }
      const summary = `imported ${d.imported}, status-updated ${d.statusUpdated ?? 0}, skipped ${d.skippedExisting} (already tracked), ${d.skippedNoUser} without a matched user (of ${d.total} sacct rows)`;
      const orphans = (d.orphans ?? []) as Array<{ slurmJobId: number; user: string }>;
      const details = orphans.length > 0
        ? `Unmatched (no local user with that unixUsername):\n${orphans.map((o) => `  ${o.slurmJobId}  ${o.user}`).join("\n")}`
        : undefined;
      setImportResult({ ok: true, summary, details });
      fetchJobs();
    } catch (e) {
      setImportResult({ ok: false, summary: e instanceof Error ? e.message : "Network error" });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Jobs</h1>
          <p className="text-muted-foreground">Manage cluster jobs</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleImport}
            disabled={importing}
            title="Import Slurm's live queue into the SlurmUI DB (admin)"
          >
            {importing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Sync from Slurm
          </Button>
          <Button
            variant="outline"
            onClick={() => setConfirmReset(true)}
            disabled={resetting}
            title="Cancel all your PENDING jobs (clears zombies from bad scheduler state)"
          >
            {resetting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eraser className="mr-2 h-4 w-4" />}
            Reset Queue
          </Button>
          {gitopsOnly ? (
            <Button disabled title="This cluster only accepts jobs from the Git Jobs repo">
              <Plus className="mr-2 h-4 w-4" />
              Submit Job (GitOps only)
            </Button>
          ) : (
            <Link href={`/clusters/${clusterId}/jobs/new`}>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Submit Job
              </Button>
            </Link>
          )}
        </div>
      </div>

      <Tabs defaultValue="jobs">
        <TabsList>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="jobs" className="mt-4 space-y-4">
      <ClusterResourcePanel clusterId={clusterId} />
      {/* Filters — inline toolbar, no box. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by job name..."
          value={nameFilter}
          onChange={(e) => setNameFilter(e.target.value)}
          className="h-9 w-64"
        />
        <Select
          value={statusFilter || "__any__"}
          onValueChange={(v) => setStatusFilter(v === "__any__" ? "" : (v ?? ""))}
        >
          <SelectTrigger className="h-9 w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any__">Any status</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={partitionFilter || "__any__"}
          onValueChange={(v) => setPartitionFilter(v === "__any__" ? "" : (v ?? ""))}
        >
          <SelectTrigger className="h-9 w-40">
            <SelectValue placeholder="Partition" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any__">Any partition</SelectItem>
            {partitions.map((p) => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          className="h-9 w-40"
          aria-label="From date"
        />
        <span className="text-sm text-muted-foreground">→</span>
        <Input
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          className="h-9 w-40"
          aria-label="To date"
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-center text-muted-foreground">Loading...</p>
      ) : (
        <>
          <JobTable jobs={jobs} onChange={fetchJobs} />

          {pagination.total > 0 && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span>{rangeStart}–{rangeEnd} of {pagination.total}</span>
                <div className="flex items-center gap-2">
                  <span>Rows per page:</span>
                  <Select
                    value={String(limit)}
                    onValueChange={(v) => { if (v) { setLimit(parseInt(v, 10)); setPage(1); } }}
                  >
                    <SelectTrigger className="h-8 w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZES.map((n) => (
                        <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {pagination.page} of {pagination.pages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
                  disabled={page >= pagination.pages}
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
        </TabsContent>

        <TabsContent value="templates" className="mt-4">
          <TemplatesPanel clusterId={clusterId} />
        </TabsContent>
      </Tabs>

      {/* Reset Queue confirm */}
      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset queue?</DialogTitle>
            <DialogDescription>
              Cancels every <strong>PENDING</strong> job you have on this cluster
              ({pendingCount} on this page). Running jobs are untouched. Useful for clearing out
              zombie jobs stuck on <code>InvalidAccount</code>, <code>Priority</code>, or similar
              scheduler issues.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Keep them</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleReset}>
              <Eraser className="mr-2 h-4 w-4" />
              Reset Queue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset result */}
      <Dialog open={!!resetResult} onOpenChange={(o) => { if (!o) setResetResult(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className={resetResult?.ok ? "" : "text-destructive"}>
              {resetResult?.ok ? "Queue reset" : "Reset failed"}
            </DialogTitle>
            {resetResult?.ok && resetResult.count !== undefined && (
              <DialogDescription>
                Cancelled {resetResult.count} job{resetResult.count === 1 ? "" : "s"} in SlurmUI&apos;s record.
                Slurm output below.
              </DialogDescription>
            )}
          </DialogHeader>
          {resetResult?.output && (
            <pre className="max-h-96 overflow-y-auto rounded-md border bg-muted p-3 text-xs font-mono whitespace-pre-wrap">
              {resetResult.output}
            </pre>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetResult(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!importResult} onOpenChange={(o) => { if (!o) setImportResult(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className={importResult?.ok ? "" : "text-destructive"}>
              {importResult?.ok ? "Synced from Slurm" : "Sync failed"}
            </DialogTitle>
            {importResult?.ok && (
              <DialogDescription>{importResult.summary}</DialogDescription>
            )}
          </DialogHeader>
          {!importResult?.ok && (
            <p className="text-sm text-destructive">{importResult?.summary}</p>
          )}
          {importResult?.details && (
            <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
              {importResult.details}
            </pre>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportResult(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
