"use client";

import { useState } from "react";
import Link from "next/link";
import { Repeat2, Loader2, XCircle } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
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
  const [busyId, setBusyId] = useState<string | null>(null);
  // API errors surface in a dialog so the table itself stays quiet.
  const [errorDialog, setErrorDialog] = useState<{ title: string; message: string } | null>(null);

  // Fresh sbatch of the stored script — works regardless of the original job's
  // status, so there's one "rerun" code path for every row.
  const rerun = async (job: Job) => {
    setBusyId(job.id);
    try {
      const res = await fetch(`/api/clusters/${job.clusterId}/jobs/${job.id}/resubmit`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        onChange?.();
      } else {
        setErrorDialog({ title: "Rerun failed", message: d.error || `HTTP ${res.status}` });
      }
    } catch (e) {
      setErrorDialog({ title: "Rerun failed", message: e instanceof Error ? e.message : "Network error" });
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (job: Job) => {
    setBusyId(job.id);
    try {
      const res = await fetch(`/api/clusters/${job.clusterId}/jobs/${job.id}`, { method: "DELETE" });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        onChange?.();
      } else {
        setErrorDialog({ title: "Cancel failed", message: d.error || `HTTP ${res.status}` });
      }
    } catch (e) {
      setErrorDialog({ title: "Cancel failed", message: e instanceof Error ? e.message : "Network error" });
    } finally {
      setBusyId(null);
    }
  };

  if (jobs.length === 0) {
    return (
      <p className="py-8 text-center text-muted-foreground">No jobs found</p>
    );
  }

  const isActive = (s: Job["status"]) => s === "PENDING" || s === "RUNNING";

  return (
    <>
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
                {/* Use suppressHydrationWarning — server renders in its own
                    timezone (UTC) but the browser formats in the user's
                    locale, which caused a hydration mismatch. The ISO
                    string on the server side and the localized version on
                    the client are semantically the same. */}
                <span suppressHydrationWarning>
                  {new Date(job.createdAt).toLocaleString()}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => rerun(job)}
                  disabled={busyId === job.id}
                  title="Rerun this job (fresh sbatch of the same script)"
                >
                  {busyId === job.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Repeat2 className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cancel(job)}
                  disabled={busyId === job.id || !isActive(job.status)}
                  title={
                    isActive(job.status)
                      ? "Cancel this running or pending job (scancel)"
                      : "Already terminal — nothing to cancel"
                  }
                  className="text-destructive hover:text-destructive"
                >
                  <XCircle className="h-3 w-3" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={!!errorDialog} onOpenChange={(o) => { if (!o) setErrorDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">{errorDialog?.title}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
            {errorDialog?.message}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setErrorDialog(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
