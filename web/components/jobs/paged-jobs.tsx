"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { JobTable } from "@/components/jobs/job-table";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface Job {
  id: string;
  slurmJobId: number | null;
  clusterId: string;
  partition: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  createdAt: string;
  cluster?: { name: string };
}

interface Pagination { page: number; limit: number; total: number; pages: number }

const PAGE_SIZES = [10, 20, 50, 100];

export function PagedJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, pages: 1 });

  useEffect(() => {
    setLoading(true);
    fetch(`/api/jobs?page=${page}&limit=${limit}`)
      .then((r) => r.json())
      .then((d) => {
        setJobs(d.jobs ?? []);
        setPagination(d.pagination ?? { page: 1, limit, total: 0, pages: 1 });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, limit]);

  const rangeStart = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
  const rangeEnd = Math.min(pagination.page * pagination.limit, pagination.total);

  if (loading && jobs.length === 0) {
    return <p className="text-center text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-4">
      <JobTable jobs={jobs} showCluster />

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
    </div>
  );
}
