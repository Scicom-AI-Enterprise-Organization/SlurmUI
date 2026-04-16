"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Loader2, Rocket } from "lucide-react";

interface BootstrapButtonProps {
  clusterId: string;
  clusterName: string;
}

type Phase = "idle" | "confirm" | "running" | "success" | "failed";

export function BootstrapButton({ clusterId, clusterName }: BootstrapButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scrollToBottom = () => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  };

  const pollTask = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}`);
      if (!res.ok) return;
      const task = await res.json();
      setLogs(task.logs ?? "");
      scrollToBottom();

      if (task.status === "success") {
        setPhase("success");
        if (pollRef.current) clearInterval(pollRef.current);
        router.refresh();
      } else if (task.status === "failed") {
        setPhase("failed");
        if (pollRef.current) clearInterval(pollRef.current);
      }
    } catch {}
  }, [router]);

  // Check for existing running task on mount
  useEffect(() => {
    fetch(`/api/clusters/${clusterId}/bootstrap/status`)
      .then((r) => r.json())
      .then((data) => {
        if (data.taskId && data.status === "running") {
          setTaskId(data.taskId);
          setPhase("running");
          setOpen(true);
          pollRef.current = setInterval(() => pollTask(data.taskId), 2000);
        }
      })
      .catch(() => {});

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [clusterId, pollTask]);

  // Poll when taskId changes
  useEffect(() => {
    scrollToBottom();
  }, [logs]);

  const handleOpen = () => {
    setPhase("confirm");
    setLogs("");
    setOpen(true);
  };

  const handleClose = () => {
    if (phase === "running") {
      // Allow closing — task continues in background
      setOpen(false);
      return;
    }
    setOpen(false);
    setPhase("idle");
  };

  const runBootstrap = async () => {
    setPhase("running");
    setLogs("");

    try {
      const res = await fetch(`/api/clusters/${clusterId}/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        setPhase("failed");
        setLogs(err.error ?? "Failed to start bootstrap");
        return;
      }

      const data = await res.json();
      setTaskId(data.taskId);

      if (data.alreadyRunning) {
        setLogs("Bootstrap is already running...\n");
      }

      // Start polling
      pollRef.current = setInterval(() => pollTask(data.taskId), 2000);
      // Initial fetch
      pollTask(data.taskId);
    } catch {
      setPhase("failed");
      setLogs("Failed to start bootstrap");
    }
  };

  const logLines = logs.split("\n");

  return (
    <>
      <Button variant="outline" onClick={phase === "running" ? () => setOpen(true) : handleOpen}>
        {phase === "running" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        <Rocket className={phase !== "running" ? "mr-2 h-4 w-4" : "hidden"} />
        {phase === "running" ? "Bootstrapping..." : "Bootstrap"}
      </Button>

      <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
        <DialogContent showCloseButton className="max-w-4xl">
          {phase === "confirm" && (
            <>
              <DialogHeader>
                <DialogTitle>Bootstrap &ldquo;{clusterName}&rdquo;</DialogTitle>
                <DialogDescription>
                  This will set up the controller node with Slurm, Munge, MariaDB, NFS, and Chrony.
                  The process runs in the background — you can close this dialog and check back later.
                </DialogDescription>
              </DialogHeader>
              <ul className="text-sm space-y-1.5 list-disc ml-5 text-muted-foreground">
                <li>Slurm controller (slurmctld) and munge authentication</li>
                <li>MariaDB for Slurm accounting</li>
                <li>NFS server for shared storage</li>
                <li>Chrony for time synchronization</li>
                <li>Minimal slurm.conf generation</li>
              </ul>
              <DialogFooter>
                <Button variant="outline" onClick={handleClose}>Cancel</Button>
                <Button onClick={runBootstrap}>
                  <Rocket className="mr-2 h-4 w-4" />
                  Run Bootstrap
                </Button>
              </DialogFooter>
            </>
          )}

          {(phase === "running" || phase === "success" || phase === "failed") && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 pr-8">
                  {phase === "running" && <Loader2 className="h-4 w-4 animate-spin" />}
                  {phase === "running" ? "Bootstrapping cluster..." :
                   phase === "success" ? "Bootstrap complete" : "Bootstrap failed"}
                </DialogTitle>
              </DialogHeader>

              <div
                ref={logRef}
                className="h-[500px] overflow-y-auto rounded-md border bg-black p-3 font-mono text-sm text-green-400"
              >
                {logLines.map((line, i) => (
                  <div
                    key={i}
                    className={`whitespace-pre-wrap leading-5 ${
                      line.startsWith("[stderr]") ? "text-yellow-400" :
                      line.startsWith("[aura]") ? "text-cyan-400" : ""
                    }`}
                  >
                    {line || "\u00A0"}
                  </div>
                ))}
                {phase === "running" && (
                  <div className="mt-1 inline-flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Running...
                  </div>
                )}
              </div>

              {phase === "success" && (
                <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 w-fit">
                  Cluster is now ACTIVE
                </Badge>
              )}

              <DialogFooter>
                {phase === "running" && (
                  <p className="text-xs text-muted-foreground mr-auto">
                    You can close this dialog — the process continues in the background.
                  </p>
                )}
                {phase === "failed" && (
                  <Button variant="outline" onClick={runBootstrap}>Retry</Button>
                )}
                <Button onClick={handleClose}>
                  {phase === "running" ? "Close (runs in background)" : phase === "success" ? "Done" : "Close"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
