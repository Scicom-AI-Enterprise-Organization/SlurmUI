"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { JobStatusBadge } from "@/components/jobs/job-status-badge";
import { LiveOutput } from "@/components/jobs/live-output";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { XCircle, RefreshCw } from "lucide-react";
import { JobUsagePanel } from "@/components/jobs/job-usage-panel";

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
  const [fetchedOutput, setFetchedOutput] = useState<string | null>(null);
  const [fetchingOutput, setFetchingOutput] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelResult, setCancelResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [infoSections, setInfoSections] = useState<Record<string, string> | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [stderrBody, setStderrBody] = useState<string | null>(null);
  const [stderrMerged, setStderrMerged] = useState<string | null>(null);
  const [stderrLoading, setStderrLoading] = useState(false);

  const fetchStderr = async () => {
    setStderrLoading(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs/${jobId}/stderr`);
      if (res.ok) {
        const d = await res.json();
        setStderrBody(d.stderr ?? "");
        setStderrMerged(d.merged ?? "unknown");
      } else {
        setStderrBody("");
      }
    } catch {
      setStderrBody("");
    } finally {
      setStderrLoading(false);
    }
  };

  const fetchInfo = async () => {
    setInfoLoading(true);
    setInfoError(null);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs/${jobId}/info`);
      if (res.ok) {
        const d = await res.json();
        setInfoSections(d.sections ?? {});
      } else {
        const err = await res.json().catch(() => ({}));
        setInfoError(err.error ?? `Server returned ${res.status}`);
      }
    } catch {
      setInfoError("Network error");
    } finally {
      setInfoLoading(false);
    }
  };

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

  // Auto-refresh while the job is in flight. 5s is tight enough that the UI
  // updates "right after" termination without hammering the API.
  useEffect(() => {
    if (!job || (job.status !== "RUNNING" && job.status !== "PENDING")) return;

    const interval = setInterval(fetchJob, 5000);
    return () => clearInterval(interval);
  }, [job?.status]);

  // For completed jobs without stored output, pull it from the cluster on demand.
  useEffect(() => {
    if (!job) return;
    const terminal = job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED";
    if (!terminal || job.output || fetchedOutput !== null || fetchingOutput) return;
    setFetchingOutput(true);
    fetch(`/api/clusters/${clusterId}/jobs/${jobId}/output`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setFetchedOutput(d.output ?? ""))
      .catch(() => setFetchedOutput(""))
      .finally(() => setFetchingOutput(false));
  }, [job, clusterId, jobId, fetchedOutput, fetchingOutput]);

  const handleCancel = async () => {
    setConfirmCancel(false);
    setCancelling(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs/${jobId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setCancelResult({ ok: true, message: "Job cancelled successfully." });
        fetchJob();
      } else {
        const err = await res.json().catch(() => ({}));
        setCancelResult({ ok: false, message: err.error ?? "Failed to cancel job." });
      }
    } catch (e) {
      setCancelResult({
        ok: false,
        message: e instanceof Error ? e.message : "Network error — could not reach the cluster API.",
      });
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
            <h1 className="text-2xl font-bold">
              {(() => {
                const m = job.script?.match(/#SBATCH\s+(?:--job-name|-J)[=\s]+(\S+)/);
                return m ? m[1] : `Job ${job.id.slice(0, 8)}`;
              })()}
            </h1>
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
              onClick={() => setConfirmCancel(true)}
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

      <Tabs defaultValue="output" onValueChange={(v) => {
        if (v === "info" && !infoSections && !infoLoading) fetchInfo();
        if (v === "stderr" && stderrBody === null && !stderrLoading) fetchStderr();
      }}>
        <TabsList>
          <TabsTrigger value="output">Output</TabsTrigger>
          <TabsTrigger value="stderr">Stderr</TabsTrigger>
          {job.status === "RUNNING" && <TabsTrigger value="usage">Usage</TabsTrigger>}
          <TabsTrigger value="info">Slurm Info</TabsTrigger>
        </TabsList>

        <TabsContent value="output" className="mt-4">
          {isRunning ? (
            <LiveOutput clusterId={clusterId} jobId={jobId} isRunning={true} />
          ) : (
            <div className="space-y-2">
              <h3 className="font-medium">Output</h3>
              <ScrollArea className="h-96 rounded-md border bg-black p-4">
                {job.output ? (
                  <pre className="font-mono text-xs text-green-400">{job.output}</pre>
                ) : fetchingOutput ? (
                  <p className="font-mono text-xs text-gray-500">Loading output from cluster...</p>
                ) : fetchedOutput ? (
                  <pre className="font-mono text-xs text-green-400">{fetchedOutput}</pre>
                ) : (
                  <p className="font-mono text-xs text-gray-500">No output captured.</p>
                )}
              </ScrollArea>
            </div>
          )}
        </TabsContent>

        <TabsContent value="stderr" className="mt-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Contents of Slurm's <code>StdErr</code> file (last 2 MB).
            </p>
            <Button variant="outline" size="sm" onClick={fetchStderr} disabled={stderrLoading}>
              <RefreshCw className={`mr-2 h-3 w-3 ${stderrLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
          {stderrMerged === "yes" && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              stderr is merged into stdout for this job (default Slurm behaviour).
              Check the Output tab instead.
            </p>
          )}
          <ScrollArea className="h-96 rounded-md border bg-black p-4">
            {stderrLoading && stderrBody === null ? (
              <p className="font-mono text-xs text-gray-500">Loading...</p>
            ) : stderrBody ? (
              <pre className="font-mono text-xs text-red-400 whitespace-pre-wrap">{stderrBody}</pre>
            ) : (
              <p className="font-mono text-xs text-gray-500">No stderr content.</p>
            )}
          </ScrollArea>
        </TabsContent>

        {job.status === "RUNNING" && (
          <TabsContent value="usage" className="mt-4">
            <JobUsagePanel clusterId={clusterId} jobId={jobId} />
          </TabsContent>
        )}

        <TabsContent value="info" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Live output from <code>scontrol</code>, <code>sacct</code>, <code>squeue</code>, <code>sinfo</code> on the controller.
            </p>
            <Button variant="outline" size="sm" onClick={fetchInfo} disabled={infoLoading}>
              <RefreshCw className={`mr-2 h-3 w-3 ${infoLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>

          {infoError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {infoError}
            </div>
          )}

          {infoLoading && !infoSections && (
            <p className="text-sm text-muted-foreground">Loading diagnostics...</p>
          )}

          {infoSections && Object.entries(infoSections).map(([name, body]) => (
            <div key={name} className="space-y-1">
              <h4 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{name}</h4>
              <div className="max-h-72 overflow-auto rounded-md border bg-black p-3">
                <pre className="font-mono text-xs text-green-400 whitespace-pre">{body || "(empty)"}</pre>
              </div>
            </div>
          ))}
        </TabsContent>
      </Tabs>

      <Separator />

      {/* Script */}
      <div className="space-y-2">
        <h3 className="font-medium">Script</h3>
        <ScrollArea className="h-64 rounded-md border">
          <pre className="p-4 font-mono text-sm">{job.script}</pre>
        </ScrollArea>
      </div>

      {/* Confirm cancel dialog */}
      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this job?</DialogTitle>
            <DialogDescription>
              This will send <code>scancel</code> to Slurm for job
              {job.slurmJobId ? ` ${job.slurmJobId}` : ""}. Any partial output
              written so far will be preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Keep running</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleCancel} disabled={cancelling}>
              <XCircle className="mr-2 h-4 w-4" />
              Cancel Job
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel result dialog */}
      <Dialog open={!!cancelResult} onOpenChange={(o) => { if (!o) setCancelResult(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className={cancelResult?.ok ? "" : "text-destructive"}>
              {cancelResult?.ok ? "Job cancelled" : "Cancel failed"}
            </DialogTitle>
            <DialogDescription>{cancelResult?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelResult(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
