"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";

interface DeleteClusterButtonProps {
  clusterId: string;
  clusterName: string;
}

type Phase = "idle" | "confirming" | "running" | "failed" | "succeeded";

const ts = () => new Date().toLocaleTimeString(undefined, { hour12: false });

export function DeleteClusterButton({ clusterId, clusterName }: DeleteClusterButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [dbDeleteState, setDbDeleteState] = useState<"pending" | "running" | "done" | "failed">("pending");
  const [dbDeleteErr, setDbDeleteErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [logs]);

  const appendLog = (line: string) => {
    setLogs((prev) => [...prev, `[${ts()}] ${line}`]);
  };

  const openDialog = () => {
    setPhase("confirming");
    setLogs([]);
    setError(null);
    setExitCode(null);
    setRequestId(null);
    setDbDeleteState("pending");
    setDbDeleteErr(null);
    setOpen(true);
  };

  const closeDialog = () => {
    if (phase === "running") return; // can't close mid-teardown
    setOpen(false);
    setPhase("idle");
  };

  const deleteDbRecord = async () => {
    setDbDeleteState("running");
    appendLog("[aura] DELETE /api/clusters/" + clusterId);
    try {
      const res = await fetch(`/api/clusters/${clusterId}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setDbDeleteState("failed");
        setDbDeleteErr(d.error ?? `HTTP ${res.status}`);
        appendLog(`[aura] DB delete failed: ${d.error ?? `HTTP ${res.status}`}`);
        return false;
      }
      setDbDeleteState("done");
      appendLog("[aura] Cluster record removed.");
      return true;
    } catch (e) {
      setDbDeleteState("failed");
      const msg = e instanceof Error ? e.message : "Network error";
      setDbDeleteErr(msg);
      appendLog(`[aura] DB delete failed: ${msg}`);
      return false;
    }
  };

  const goToList = () => {
    router.push("/admin/clusters");
    router.refresh();
  };

  const runTeardown = async () => {
    setPhase("running");
    setLogs([]);
    setError(null);
    setExitCode(null);
    setRequestId(null);
    setDbDeleteState("pending");
    setDbDeleteErr(null);

    appendLog("[aura] POST /api/clusters/" + clusterId + "/teardown");

    const res = await fetch(`/api/clusters/${clusterId}/teardown`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Teardown request failed" }));
      appendLog(`[aura] HTTP ${res.status}: ${data.error ?? "Teardown request failed"}`);
      setError(data.error ?? `Teardown request failed (HTTP ${res.status})`);
      setPhase("failed");
      return;
    }

    const contentType = res.headers.get("content-type") ?? "";

    // SSH mode: teardown returns an SSE stream directly
    if (contentType.includes("text/event-stream") && res.body) {
      appendLog("[aura] Streaming SSH teardown output...");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "stream") {
              setLogs((prev) => [...prev, `[${ts()}] ${event.line}`]);
            } else if (event.type === "complete") {
              if (typeof event.payload?.exitCode === "number") setExitCode(event.payload.exitCode);
              if (event.success) {
                appendLog("[aura] Teardown finished (exit=0). Removing DB record...");
                const ok = await deleteDbRecord();
                setPhase(ok ? "succeeded" : "failed");
                if (!ok) setError("Teardown OK but DB delete failed — see log.");
              } else {
                const msg = event.payload?.error ?? `Teardown failed (exit=${event.payload?.exitCode ?? "?"})`;
                appendLog(`[aura] ${msg}`);
                setError(msg);
                setPhase("failed");
              }
              return;
            }
          } catch (e) {
            appendLog(`[aura] Failed to parse SSE: ${e instanceof Error ? e.message : "unknown"}`);
          }
        }
      }
      return;
    }

    // NATS mode: teardown returns { request_id }, stream via EventSource
    const data = await res.json();
    const request_id = data.request_id;
    setRequestId(request_id);
    appendLog(`[aura] NATS teardown — request_id=${request_id}`);

    const evtSource = new EventSource(`/api/clusters/${clusterId}/stream/${request_id}`);

    const timeout = setTimeout(() => {
      evtSource.close();
      appendLog("[aura] Stream timed out after 3 minutes — agent unreachable?");
      setError("Teardown timed out after 3 minutes — agent may be unreachable.");
      setPhase("failed");
    }, 3 * 60 * 1000);

    evtSource.onmessage = async (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "stream") {
          setLogs((prev) => [...prev, `[${ts()}] ${event.line}`]);
        } else if (event.type === "complete") {
          clearTimeout(timeout);
          evtSource.close();
          if (typeof event.payload?.exit_code === "number") setExitCode(event.payload.exit_code);
          if (event.success) {
            appendLog("[aura] Agent reported success. Removing DB record...");
            const ok = await deleteDbRecord();
            setPhase(ok ? "succeeded" : "failed");
            if (!ok) setError("Teardown OK but DB delete failed — see log.");
          } else {
            const msg = event.payload?.error ?? "Teardown failed";
            appendLog(`[aura] ${msg}`);
            setError(msg);
            setPhase("failed");
          }
        }
      } catch (parseErr) {
        appendLog(`[aura] Failed to parse SSE: ${parseErr instanceof Error ? parseErr.message : "unknown"}`);
      }
    };
    evtSource.onerror = () => {
      clearTimeout(timeout);
      evtSource.close();
      appendLog("[aura] EventSource error — connection lost.");
      setError("Connection lost during teardown — agent may be offline.");
      setPhase("failed");
    };
  };

  const forceDelete = async () => {
    appendLog("[aura] Force delete (skipping cleanup)");
    const ok = await deleteDbRecord();
    setPhase(ok ? "succeeded" : "failed");
    if (!ok) setError("Force delete failed — see log.");
  };

  return (
    <>
      <Button variant="destructive" size="sm" onClick={openDialog}>
        <Trash2 className="mr-2 h-4 w-4" />
        Delete
      </Button>

      <Dialog open={open} onOpenChange={(o) => { if (!o) closeDialog(); }}>
        <DialogContent showCloseButton={phase !== "running"} className="max-w-2xl">
          {phase === "confirming" && (
            <>
              <DialogHeader>
                <DialogTitle>Delete &ldquo;{clusterName}&rdquo;?</DialogTitle>
                <DialogDescription>
                  This will run a full teardown before removing the cluster record:
                </DialogDescription>
              </DialogHeader>
              <ul className="text-sm space-y-1.5 list-disc ml-5 text-muted-foreground">
                <li>Stop and purge Slurm daemons (slurmctld, slurmd, munge) on all nodes</li>
                <li>Unmount NFS shares on worker nodes and remove fstab entries</li>
                <li>Remove Aura-created configs: /etc/slurm, munge key, /etc/hosts entries</li>
                <li>Uninstall the Aura agent service and binary from the controller</li>
              </ul>
              <p className="text-sm text-muted-foreground mt-1">
                The nodes themselves are not deprovisioned — only Aura-managed software and
                configuration is removed. You can safely reprovision after this.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={closeDialog}>Cancel</Button>
                <Button variant="destructive" onClick={runTeardown}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Run Teardown &amp; Delete
                </Button>
              </DialogFooter>
            </>
          )}

          {(phase === "running" || phase === "failed" || phase === "succeeded") && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {phase === "running" && <Loader2 className="h-4 w-4 animate-spin" />}
                  {phase === "failed" && <AlertTriangle className="h-4 w-4 text-destructive" />}
                  {phase === "succeeded" && <Trash2 className="h-4 w-4 text-chart-2" />}
                  {phase === "running" ? "Tearing down cluster…" :
                   phase === "succeeded" ? `Cluster "${clusterName}" deleted` :
                   "Teardown failed"}
                </DialogTitle>
                <DialogDescription>
                  {requestId && <span className="font-mono text-[11px]">request_id: {requestId}</span>}
                  {requestId && (exitCode !== null) && " · "}
                  {exitCode !== null && <span className="font-mono text-[11px]">exit code: {exitCode}</span>}
                </DialogDescription>
              </DialogHeader>

              <div
                ref={logRef}
                className="h-72 overflow-y-auto rounded-md border bg-black p-3 font-mono text-xs text-green-400"
              >
                {logs.length === 0 && <span className="text-gray-500">Starting…</span>}
                {logs.map((l, i) => (
                  <div key={i} className="whitespace-pre-wrap leading-5">{l}</div>
                ))}
                {phase === "running" && (
                  <div className="mt-1 text-yellow-400 animate-pulse">⠋ running…</div>
                )}
              </div>

              {phase === "failed" && error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <p className="font-semibold mb-1">Error</p>
                  <p className="font-mono text-xs whitespace-pre-wrap break-all">{error}</p>
                  {dbDeleteState === "failed" && dbDeleteErr && (
                    <p className="mt-2 font-mono text-xs whitespace-pre-wrap break-all">DB: {dbDeleteErr}</p>
                  )}
                </div>
              )}

              {phase === "succeeded" && (
                <div className="rounded-md border border-chart-2/40 bg-chart-2/5 px-3 py-2 text-sm">
                  Teardown finished cleanly and the cluster record was removed.
                  Click <strong>Done</strong> to return to the cluster list.
                </div>
              )}

              <DialogFooter className="flex-row justify-between sm:justify-between">
                <Button
                  variant="ghost" size="sm"
                  onClick={() => navigator.clipboard?.writeText(logs.join("\n"))}
                  disabled={logs.length === 0}
                >
                  Copy log
                </Button>
                <div className="flex gap-2">
                  {phase === "failed" && (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => { setPhase("confirming"); setLogs([]); setError(null); setExitCode(null); setRequestId(null); }}
                      >
                        Retry Teardown
                      </Button>
                      <Button variant="destructive" onClick={forceDelete}>
                        Force Delete (skip cleanup)
                      </Button>
                    </>
                  )}
                  {phase === "succeeded" && (
                    <Button variant="default" onClick={() => { setOpen(false); goToList(); }}>
                      Done
                    </Button>
                  )}
                  {phase !== "running" && (
                    <Button variant="outline" onClick={closeDialog}>
                      {phase === "succeeded" ? "Stay here" : "Close"}
                    </Button>
                  )}
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
