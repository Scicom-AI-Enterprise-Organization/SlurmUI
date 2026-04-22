"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
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
import { XCircle, RefreshCw, RotateCw, Repeat2 } from "lucide-react";
import { JobUsagePanel } from "@/components/jobs/job-usage-panel";

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

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
  user?: { email: string; name: string | null; unixUsername: string | null };
}

const TAB_VALUES = ["output", "stderr", "usage", "info"] as const;
type TabValue = (typeof TAB_VALUES)[number];

export default function JobDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const clusterId = params.id as string;
  const jobId = params.jobId as string;

  // Tab state is URL-synced via ?tab=… so the URL is shareable / reloadable.
  // Invalid or missing values default to "output".
  const urlTab = searchParams.get("tab");
  const initialTab: TabValue =
    TAB_VALUES.includes(urlTab as TabValue) ? (urlTab as TabValue) : "output";
  const [tab, setTab] = useState<TabValue>(initialTab);
  const changeTab = (v: string) => {
    if (!TAB_VALUES.includes(v as TabValue)) return;
    setTab(v as TabValue);
    if (typeof window === "undefined") return;
    // Use history.replaceState directly instead of router.replace — Next's
    // App Router treats router.replace as a soft nav that refetches server
    // components, which in this nested layout was silently dropping the
    // query change. window.history works unconditionally and doesn't cost
    // a server round-trip.
    const qs = new URLSearchParams(window.location.search);
    if (v === "output") qs.delete("tab"); else qs.set("tab", v);
    const q = qs.toString();
    const url = q ? `${window.location.pathname}?${q}` : window.location.pathname;
    window.history.replaceState(window.history.state, "", url);
  };

  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [fetchedOutput, setFetchedOutput] = useState<string | null>(null);
  const [fetchingOutput, setFetchingOutput] = useState(false);
  // Total file size on disk (0 when unknown, e.g. DB-cached response) and
  // how many bytes of it the current `fetchedOutput` covers, counted from
  // the END of the file (the initial fetch returns the tail). Used to drive
  // the "Load earlier" button on logs longer than 5 MB.
  const [outputSize, setOutputSize] = useState<number>(0);
  const [outputTailOffset, setOutputTailOffset] = useState<number>(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelResult, setCancelResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [infoSections, setInfoSections] = useState<Record<string, string> | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [stderrBody, setStderrBody] = useState<string | null>(null);
  const [stderrMerged, setStderrMerged] = useState<string | null>(null);
  const [stderrLoading, setStderrLoading] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restartLogOpen, setRestartLogOpen] = useState(false);
  const [restartLogLines, setRestartLogLines] = useState<string[]>([]);
  const [restartLogStatus, setRestartLogStatus] = useState<"streaming" | "complete" | "error">("streaming");
  const [restartJobId, setRestartJobId] = useState<string | null>(null);

  const handleRestart = async () => {
    if (!job) return;
    setConfirmRestart(false);
    setRestarting(true);
    setRestartLogLines([]);
    setRestartLogStatus("streaming");
    setRestartJobId(null);
    setRestartLogOpen(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs/${job.id}/resubmit`, {
        method: "POST",
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.taskId) {
        setRestartLogLines((prev) => [...prev, `[error] ${d.error ?? `HTTP ${res.status}`}`]);
        setRestartLogStatus("error");
        setRestarting(false);
        return;
      }
      const taskId = d.taskId as string;
      // Poll the task for streaming logs. Stops when task status flips
      // to success/failed. Mirrors the admin node/deploy/diagnose flows.
      const poll = setInterval(async () => {
        try {
          const taskRes = await fetch(`/api/tasks/${taskId}`);
          if (!taskRes.ok) return;
          const t = await taskRes.json();
          // Strip the resubmit-job-id marker line before displaying.
          const logs: string = t.logs ?? "";
          const jobIdMatch = logs.match(/__AURA_RESUBMIT_JOB_ID__=([a-f0-9-]+)/);
          const cleaned = logs.replace(/__AURA_RESUBMIT_JOB_ID__=.*\n?/g, "");
          setRestartLogLines(cleaned ? cleaned.split("\n") : []);
          if (jobIdMatch) setRestartJobId(jobIdMatch[1]);
          if (t.status === "success") {
            setRestartLogStatus("complete");
            clearInterval(poll);
            setRestarting(false);
            fetchJob();
          } else if (t.status === "failed") {
            setRestartLogStatus("error");
            clearInterval(poll);
            setRestarting(false);
          }
        } catch {}
      }, 2000);
    } catch (e) {
      setRestartLogLines((prev) => [...prev, `[error] ${e instanceof Error ? e.message : "Network error"}`]);
      setRestartLogStatus("error");
      setRestarting(false);
    }
  };

  const resync = async () => {
    setResyncing(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/jobs/${jobId}/resync`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) {
        toast.error("Resync failed", { description: d.error ?? `HTTP ${res.status}` });
        return;
      }
      if (!d.next) {
        toast.warning("No Slurm state returned", { description: d.error ?? "Row unchanged." });
      } else if (d.updated) {
        toast.success(`Status: ${d.previous} → ${d.next}`, { description: `Source: ${d.source}` });
      } else {
        toast.info(`Status unchanged (${d.next})`, { description: `Source: ${d.source}` });
      }
      fetchJob();
    } catch (e) {
      toast.error("Resync failed", { description: e instanceof Error ? e.message : "Network error" });
    } finally {
      setResyncing(false);
    }
  };

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
      // swallow — transient network blips shouldn't toast-spam the user
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJob();
  }, [clusterId, jobId]);

  // Kick off the lazy fetches when landing on /…?tab=info or ?tab=stderr
  // directly — otherwise the tab renders empty until the user clicks it.
  useEffect(() => {
    if (tab === "info" && !infoSections && !infoLoading) fetchInfo();
    if (tab === "stderr" && stderrBody === null && !stderrLoading) fetchStderr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // If the URL asked for ?tab=usage but the job isn't running, fall back
  // silently to the output tab so the user isn't stuck on an empty panel.
  useEffect(() => {
    if (!job) return;
    if (tab === "usage" && job.status !== "RUNNING") changeTab("output");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

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
    // Always fetch — even if job.output is cached — so we get the real
    // on-disk size and can surface truncation / "load earlier" affordances.
    if (!terminal || fetchedOutput !== null || fetchingOutput) return;
    setFetchingOutput(true);
    fetch(`/api/clusters/${clusterId}/jobs/${jobId}/output`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setFetchedOutput(d.output ?? "");
        setOutputSize(Number(d.size ?? 0));
        setOutputTailOffset(Number(d.offset ?? 0));
      })
      .catch(() => setFetchedOutput(""))
      .finally(() => setFetchingOutput(false));
  }, [job, clusterId, jobId, fetchedOutput, fetchingOutput]);

  // Pull the chunk immediately preceding what we already have. The server
  // returns bytes [offset, offset+limit); we want [0, current tail offset).
  const loadEarlier = async () => {
    if (loadingMore || outputTailOffset <= 0) return;
    setLoadingMore(true);
    try {
      const limit = outputTailOffset;
      const res = await fetch(
        `/api/clusters/${clusterId}/jobs/${jobId}/output?offset=0&limit=${limit}`,
      );
      if (!res.ok) return;
      const d = await res.json();
      const chunk: string = d.output ?? "";
      setFetchedOutput((prev) => (chunk + (prev ?? "")));
      setOutputTailOffset(0);
      if (d.size) setOutputSize(Number(d.size));
    } finally {
      setLoadingMore(false);
    }
  };

  // Re-fetch the tail from disk, bypassing any DB-cached value. Useful when
  // the file has grown (or was written post-completion) and the stored
  // Job.output is shorter than what's on disk.
  const refetchFromDisk = async () => {
    if (fetchingOutput || loadingMore) return;
    setFetchingOutput(true);
    try {
      // Using offset=0 with a default cap forces range mode → SSH + no DB cache.
      const res = await fetch(
        `/api/clusters/${clusterId}/jobs/${jobId}/output?offset=0&limit=5242880`,
      );
      if (!res.ok) return;
      const d = await res.json();
      const size = Number(d.size ?? 0);
      const returned: string = d.output ?? "";
      // If the file is larger than the 5 MB we just pulled, the chunk is the
      // HEAD of the file — set tailOffset so "Load earlier" vanishes and a
      // follow-up fetch of the tail would be an explicit user action. Simpler
      // path: if file fits, show it as-is; otherwise pull the tail so it
      // matches the usual "last 5 MB" presentation.
      if (size > returned.length) {
        const tailRes = await fetch(
          `/api/clusters/${clusterId}/jobs/${jobId}/output?offset=${size - 5242880}&limit=5242880`,
        );
        if (tailRes.ok) {
          const td = await tailRes.json();
          setFetchedOutput(td.output ?? "");
          setOutputSize(Number(td.size ?? size));
          setOutputTailOffset(Number(td.offset ?? 0));
          return;
        }
      }
      setFetchedOutput(returned);
      setOutputSize(size);
      setOutputTailOffset(0);
    } finally {
      setFetchingOutput(false);
    }
  };

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
            {job.user && (
              <>
                {" | "}Submitted by:{" "}
                <span className="font-medium text-foreground">
                  {job.user.name || job.user.unixUsername || job.user.email}
                </span>
                {job.user.name && (
                  <span className="ml-1 text-xs">&lt;{job.user.email}&gt;</span>
                )}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchJob}>
            <RefreshCw className="mr-2 h-3 w-3" />
            Refresh
          </Button>
          {job.slurmJobId && (
            <Button variant="outline" size="sm" onClick={resync} disabled={resyncing}
              title="Re-query Slurm and overwrite the stored status">
              <RotateCw className={`mr-2 h-3 w-3 ${resyncing ? "animate-spin" : ""}`} />
              {resyncing ? "Resyncing..." : "Resync state"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmRestart(true)}
            disabled={restarting}
            title="Rerun this job — fresh sbatch of the stored script"
          >
            <Repeat2 className={`mr-2 h-3 w-3 ${restarting ? "animate-spin" : ""}`} />
            {restarting ? "Restarting..." : "Restart"}
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

      <Tabs value={tab} onValueChange={(v) => {
        changeTab(v);
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
              <div className="flex items-center justify-between">
                <h3 className="font-medium">Output</h3>
                <div className="flex items-center gap-2">
                  {outputSize > 0 && fetchedOutput !== null && (
                    <span className="text-xs text-muted-foreground">
                      {fmtBytes(fetchedOutput.length)} of {fmtBytes(outputSize)}
                      {outputTailOffset > 0 && ` — ${fmtBytes(outputTailOffset)} earlier not shown`}
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={refetchFromDisk}
                    disabled={fetchingOutput || loadingMore}
                    title="Re-read from disk, bypassing the stored snapshot"
                  >
                    <RefreshCw className={`mr-2 h-3 w-3 ${fetchingOutput ? "animate-spin" : ""}`} />
                    Refresh from disk
                  </Button>
                </div>
              </div>
              <ScrollArea className="h-96 rounded-md border bg-black p-4">
                {fetchingOutput && fetchedOutput === null ? (
                  <p className="font-mono text-xs text-gray-500">Loading output from cluster...</p>
                ) : fetchedOutput !== null ? (
                  <>
                    {outputTailOffset > 0 && (
                      <div className="mb-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={loadEarlier}
                          disabled={loadingMore}
                          className="text-xs"
                        >
                          {loadingMore ? "Loading..." : `Load earlier (${fmtBytes(outputTailOffset)})`}
                        </Button>
                      </div>
                    )}
                    {fetchedOutput ? (
                      <pre className="font-mono text-xs text-green-400">{fetchedOutput}</pre>
                    ) : (
                      <p className="font-mono text-xs text-gray-500">No output captured.</p>
                    )}
                  </>
                ) : job.output ? (
                  <pre className="font-mono text-xs text-green-400">{job.output}</pre>
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

      {/* Confirm restart dialog */}
      <Dialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rerun this job?</DialogTitle>
            <DialogDescription>
              Submits a fresh <code>sbatch</code> of the stored script. Creates a new Job row
              with a new Slurm ID; the original row stays as history. Any currently-running
              job for this row is <em>not</em> cancelled — cancel it first if that's what you want.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRestart(false)}>Cancel</Button>
            <Button onClick={handleRestart} disabled={restarting}>
              <Repeat2 className="mr-2 h-4 w-4" />
              Restart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Live log dialog — streams SSH output while the resubmit runs. */}
      <Dialog open={restartLogOpen} onOpenChange={(o) => { if (!o && restartLogStatus !== "streaming") setRestartLogOpen(false); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {restartLogStatus === "complete"
                ? (restartJobId ? `Job resubmitted as ${restartJobId.slice(0, 8)}` : "Job resubmitted")
                : restartLogStatus === "error"
                  ? "Rerun failed"
                  : `Rerunning job ${job?.id.slice(0, 8)}`}
              {restartLogStatus === "streaming" && <span className="ml-2 text-xs text-muted-foreground">(running…)</span>}
            </DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {restartLogLines.join("\n") || "Waiting for output…"}
          </pre>
          <DialogFooter>
            {restartLogStatus === "complete" && restartJobId ? (
              <Button
                onClick={() => {
                  setRestartLogOpen(false);
                  window.location.href = `/clusters/${clusterId}/jobs/${restartJobId}`;
                }}
              >
                Go to job {restartJobId.slice(0, 8)}
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => setRestartLogOpen(false)}
                disabled={restartLogStatus === "streaming"}
              >
                {restartLogStatus === "streaming" ? "Running…" : "Close"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
