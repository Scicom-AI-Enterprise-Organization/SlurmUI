"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { JobStatusBadge } from "@/components/jobs/job-status-badge";
import { LiveOutput } from "@/components/jobs/live-output";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { XCircle, RefreshCw } from "lucide-react";

interface JobDetail {
  id: string;
  slurmJobId: number | null;
  clusterId: string;
  userId: string;
  script: string;
  partition: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  exitCode: number | null;
  output: string | null;
  createdAt: string;
  updatedAt: string;
  cluster?: { name: string; status: string };
}

export default function JobDetailPage() {
  const params = useParams();
  const clusterId = params.id as string;
  const jobId = params.jobId as string;

  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);

  const fetchJob = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs/${jobId}`);
      if (res.ok) {
        setJob(await res.json());
      }
    } catch {
      toast.error("Failed to load job");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJob();
  }, [clusterId, jobId]);

  // Poll for status updates when job is running
  useEffect(() => {
    if (!job || (job.status !== "RUNNING" && job.status !== "PENDING")) return;

    const interval = setInterval(fetchJob, 10000);
    return () => clearInterval(interval);
  }, [job?.status]);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs/${jobId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Job cancelled");
        fetchJob();
      } else {
        const err = await res.json();
        toast.error(err.error ?? "Failed to cancel");
      }
    } finally {
      setCancelling(false);
    }
  };

  if (loading && !job) {
    return <p className="text-center text-muted-foreground">Loading...</p>;
  }

  if (!job) {
    return <p className="text-center text-muted-foreground">Job not found</p>;
  }

  const isRunning = job.status === "RUNNING" || job.status === "PENDING";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Job {job.id.slice(0, 8)}</h1>
            <JobStatusBadge status={job.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            Cluster: {job.cluster?.name ?? clusterId} | Partition: {job.partition}
            {job.slurmJobId && ` | Slurm ID: ${job.slurmJobId}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchJob}>
            <RefreshCw className="mr-2 h-3 w-3" />
            Refresh
          </Button>
          {isRunning && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleCancel}
              disabled={cancelling}
            >
              <XCircle className="mr-2 h-3 w-3" />
              {cancelling ? "Cancelling..." : "Cancel Job"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Status</p>
            <JobStatusBadge status={job.status} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Exit Code</p>
            <p className="text-lg font-bold">{job.exitCode ?? "-"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Created</p>
            <p className="text-sm">{new Date(job.createdAt).toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Updated</p>
            <p className="text-sm">{new Date(job.updatedAt).toLocaleString()}</p>
          </CardContent>
        </Card>
      </div>

      <Separator />

      {/* Live output for running jobs */}
      {isRunning && (
        <LiveOutput clusterId={clusterId} jobId={jobId} isRunning={true} />
      )}

      {/* Stored output for completed/failed jobs */}
      {!isRunning && (
        <div className="space-y-2">
          <h3 className="font-medium">Output</h3>
          <ScrollArea className="h-96 rounded-md border bg-black p-4">
            {job.output ? (
              <pre className="font-mono text-xs text-green-400">{job.output}</pre>
            ) : (
              <p className="font-mono text-xs text-gray-500">No output captured.</p>
            )}
          </ScrollArea>
        </div>
      )}

      <Separator />

      {/* Script */}
      <div className="space-y-2">
        <h3 className="font-medium">Script</h3>
        <ScrollArea className="h-64 rounded-md border">
          <pre className="p-4 font-mono text-sm">{job.script}</pre>
        </ScrollArea>
      </div>
    </div>
  );
}
