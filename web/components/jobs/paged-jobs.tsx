"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  name?: string | null;
  cluster?: { name: string };
}

interface Pagination { page: number; limit: number; total: number; pages: number }

const PAGE_SIZES = [10, 20, 50, 100];
const STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;

export function PagedJobs() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

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
  const [clusterFilter, setClusterFilter] = useState(() => searchParams.get("cluster") ?? "");
  const [clusters, setClusters] = useState<Array<{ id: string; name: string }>>([]);
  const [fromDate, setFromDate] = useState(() => searchParams.get("from") ?? "");
  const [toDate, setToDate] = useState(() => searchParams.get("to") ?? "");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedName(nameFilter), 300);
    return () => clearTimeout(t);
  }, [nameFilter]);

  useEffect(() => {
    setPage(1);
  }, [debouncedName, statusFilter, partitionFilter, clusterFilter, fromDate, toDate]);

  // State → URL so the filters are shareable/back-navigable.
  useEffect(() => {
    const qs = new URLSearchParams();
    if (debouncedName) qs.set("name", debouncedName);
    if (statusFilter) qs.set("status", statusFilter);
    if (partitionFilter) qs.set("partition", partitionFilter);
    if (clusterFilter) qs.set("cluster", clusterFilter);
    if (fromDate) qs.set("from", fromDate);
    if (toDate) qs.set("to", toDate);
    if (page > 1) qs.set("page", String(page));
    if (limit !== 20) qs.set("limit", String(limit));
    const qsStr = qs.toString();
    router.replace(qsStr ? `${pathname}?${qsStr}` : pathname, { scroll: false });
  }, [debouncedName, statusFilter, partitionFilter, clusterFilter, fromDate, toDate, page, limit, pathname, router]);

  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (debouncedName) qs.set("name", debouncedName);
    if (statusFilter) qs.set("status", statusFilter);
    if (partitionFilter) qs.set("partition", partitionFilter);
    if (clusterFilter) qs.set("cluster", clusterFilter);
    if (fromDate) qs.set("from", fromDate);
    if (toDate) qs.set("to", toDate);
    fetch(`/api/jobs?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        setJobs(d.jobs ?? []);
        setPagination(d.pagination ?? { page: 1, limit, total: 0, pages: 1 });
        setPartitions(d.partitions ?? []);
        setClusters(d.clusters ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, limit, debouncedName, statusFilter, partitionFilter, clusterFilter, fromDate, toDate]);

  const rangeStart = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
  const rangeEnd = Math.min(pagination.page * pagination.limit, pagination.total);

  const hasFilters = !!(nameFilter || statusFilter || partitionFilter || clusterFilter || fromDate || toDate);
  const clearFilters = () => {
    setNameFilter("");
    setStatusFilter("");
    setPartitionFilter("");
    setClusterFilter("");
    setFromDate("");
    setToDate("");
  };

  return (
    <div className="space-y-4">
      {/* Filters — inline toolbar. */}
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
          value={clusterFilter || "__any__"}
          onValueChange={(v) => setClusterFilter(v === "__any__" ? "" : (v ?? ""))}
        >
          <SelectTrigger className="h-9 w-48">
            <SelectValue placeholder="Cluster" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any__">Any cluster</SelectItem>
            {clusters.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
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

      {loading && jobs.length === 0 ? (
        <p className="text-center text-muted-foreground">Loading...</p>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
