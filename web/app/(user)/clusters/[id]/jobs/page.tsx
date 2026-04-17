"use client";

import { useEffect, useState } from "react";
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
import { Plus, ChevronLeft, ChevronRight, Eraser, Loader2 } from "lucide-react";
import Link from "next/link";

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

export default function JobListPage() {
  const params = useParams();
  const clusterId = params.id as string;
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Initialize state from URL so the page is shareable/bookmarkable and
  // filter state survives refresh.
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(() => parseInt(searchParams.get("page") ?? "1") || 1);
  const [limit, setLimit] = useState(() => parseInt(searchParams.get("limit") ?? "20") || 20);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, pages: 1 });

  const [nameFilter, setNameFilter] = useState(() => searchParams.get("name") ?? "");
  const [debouncedName, setDebouncedName] = useState(() => searchParams.get("name") ?? "");
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get("status") ?? "");
  const [partitionFilter, setPartitionFilter] = useState(() => searchParams.get("partition") ?? "");
  const [partitions, setPartitions] = useState<string[]>([]);
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
      .catch(() => toast.error("Failed to load jobs"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
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
            onClick={() => setConfirmReset(true)}
            disabled={resetting}
            title="Cancel all your PENDING jobs (clears zombies from bad scheduler state)"
          >
            {resetting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eraser className="mr-2 h-4 w-4" />}
            Reset Queue
          </Button>
          <Link href={`/clusters/${clusterId}/jobs/new`}>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Submit Job
            </Button>
          </Link>
        </div>
      </div>

      <Tabs defaultValue="jobs">
        <TabsList>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="jobs" className="mt-4 space-y-4">
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
          <JobTable jobs={jobs} />

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
                Cancelled {resetResult.count} job{resetResult.count === 1 ? "" : "s"} in Aura&apos;s record.
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
    </div>
  );
}
