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

type Phase = "idle" | "confirming" | "running" | "failed";

export function DeleteClusterButton({ clusterId, clusterName }: DeleteClusterButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [logs]);

  const appendLog = (line: string) => {
    setLogs((prev) => [...prev, line]);
  };

  const openDialog = () => {
    setPhase("confirming");
    setLogs([]);
    setError(null);
    setOpen(true);
  };

  const closeDialog = () => {
    if (phase === "running") return;
    setOpen(false);
    setPhase("idle");
  };

  const deleteDbRecord = async () => {
    await fetch(`/api/clusters/${clusterId}`, { method: "DELETE" });
    router.push("/admin/clusters");
    router.refresh();
  };

  const runTeardown = async () => {
    setPhase("running");
    setLogs([]);
    setError(null);

    const res = await fetch(`/api/clusters/${clusterId}/teardown`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Teardown request failed" }));
      setError(data.error ?? "Teardown request failed");
      setPhase("failed");
      return;
    }
    const { request_id } = await res.json();

    const evtSource = new EventSource(`/api/clusters/${clusterId}/stream/${request_id}`);

    // Client-side timeout: surface Force Delete after 3 minutes if no completion
    const timeout = setTimeout(() => {
      evtSource.close();
      setError("Teardown timed out after 3 minutes — agent may be unreachable.");
      setPhase("failed");
    }, 3 * 60 * 1000);

    evtSource.onmessage = async (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "stream") {
          appendLog(event.line);
        } else if (event.type === "complete") {
          clearTimeout(timeout);
          evtSource.close();
          if (event.success) {
            appendLog("[aura] Removing cluster record...");
            await deleteDbRecord();
          } else {
            setError(event.payload?.error ?? "Teardown failed");
            setPhase("failed");
          }
        }
      } catch {}
    };
    evtSource.onerror = () => {
      clearTimeout(timeout);
      evtSource.close();
      setError("Connection lost during teardown — agent may be offline.");
      setPhase("failed");
    };
  };

  const forceDelete = async () => {
    await deleteDbRecord();
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

          {(phase === "running" || phase === "failed") && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {phase === "running" && <Loader2 className="h-4 w-4 animate-spin" />}
                  {phase === "failed" && <AlertTriangle className="h-4 w-4 text-destructive" />}
                  {phase === "running" ? "Tearing down cluster…" : "Teardown failed"}
                </DialogTitle>
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
                  {error}
                </div>
              )}

              {phase === "failed" && (
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => { setPhase("confirming"); setLogs([]); setError(null); }}
                  >
                    Retry Teardown
                  </Button>
                  <Button variant="destructive" onClick={forceDelete}>
                    Force Delete (skip cleanup)
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
