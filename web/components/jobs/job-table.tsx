"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Repeat2, Loader2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { JobStatusBadge } from "./job-status-badge";

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

interface JobTableProps {
  jobs: Job[];
  showCluster?: boolean;
  onChange?: () => void;
}

export function JobTable({ jobs, showCluster = false, onChange }: JobTableProps) {
  const [restartingId, setRestartingId] = useState<string | null>(null);

  const restart = async (job: Job) => {
    if (!job.slurmJobId) return;
    setRestartingId(job.id);
    try {
      const res = await fetch(`/api/clusters/${job.clusterId}/slurm-control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slurmJobId: String(job.slurmJobId), action: "requeue" }),
      });
      const d = await res.json().catch(() => ({}));
      const ok = res.ok && d.success !== false;
      if (ok) {
        toast.success(`Requeued job ${job.slurmJobId}`);
        onChange?.();
      } else {
        toast.error("Restart failed", { description: d.error || d.output || `HTTP ${res.status}` });
      }
    } catch (e) {
      toast.error("Restart failed", { description: e instanceof Error ? e.message : "Network error" });
    } finally {
      setRestartingId(null);
    }
  };

  if (jobs.length === 0) {
    return (
      <p className="py-8 text-center text-muted-foreground">No jobs found</p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Job ID</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Slurm ID</TableHead>
          {showCluster && <TableHead>Cluster</TableHead>}
          <TableHead>Partition</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id}>
            <TableCell>
              <Link
                href={`/clusters/${job.clusterId}/jobs/${job.id}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {job.id.slice(0, 8)}...
              </Link>
            </TableCell>
            <TableCell className="font-mono text-sm">{job.name ?? <span className="text-muted-foreground">-</span>}</TableCell>
            <TableCell>{job.slurmJobId ?? "-"}</TableCell>
            {showCluster && (
              <TableCell>{job.cluster?.name ?? job.clusterId.slice(0, 8)}</TableCell>
            )}
            <TableCell>{job.partition}</TableCell>
            <TableCell>
              <JobStatusBadge status={job.status} />
            </TableCell>
            <TableCell>
              {new Date(job.createdAt).toLocaleString()}
            </TableCell>
            <TableCell className="text-right">
              {job.status === "FAILED" && job.slurmJobId ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => restart(job)}
                  disabled={restartingId === job.id}
                  title="Requeue this failed job (scontrol requeue)"
                >
                  {restartingId === job.id ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Repeat2 className="mr-1 h-3 w-3" />
                  )}
                  Restart
                </Button>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
