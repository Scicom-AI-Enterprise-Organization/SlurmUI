"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
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
}

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

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, pages: 1 });

  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<{ ok: boolean; output: string; count?: number } | null>(null);

  const fetchJobs = () => {
    setLoading(true);
    fetch(`/api/clusters/${clusterId}/jobs?page=${page}&limit=${limit}`)
      .then((res) => res.json())
      .then((data) => {
        setJobs(data.jobs ?? []);
        setPagination(data.pagination ?? { page: 1, limit, total: 0, pages: 1 });
      })
      .catch(() => toast.error("Failed to load jobs"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, page, limit]);

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
