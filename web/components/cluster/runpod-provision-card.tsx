"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Cpu, Loader2 } from "lucide-react";

interface RunpodInfo {
  podId: string;
  gpuTypeId: string;
  gpuCount: number;
  cloudType: string;
  imageName: string;
  containerDiskGb: number;
  // Absent on clusters created before volume support landed.
  volumeGb?: number;
  volumeMountPath?: string;
  // True for "instant cluster" pods launched from the pre-baked slurm-node
  // image — Slurm comes up on boot and the cluster goes ACTIVE without Bootstrap.
  instant?: boolean;
}

interface TaskSnapshot {
  id: string;
  status: string; // "running" | "success" | "failed"
  logs: string;
}

interface RunpodProvisionCardProps {
  runpod: RunpodInfo;
  initialTask: TaskSnapshot | null;
}

// Shows the rented pod's details + the runpod_provision task logs on the
// Configuration tab. Polls while provisioning is still running, then
// refreshes the page so the cards gated on controller reachability appear.
export function RunpodProvisionCard({ runpod, initialTask }: RunpodProvisionCardProps) {
  const router = useRouter();
  const [task, setTask] = useState<TaskSnapshot | null>(initialTask);
  const logRef = useRef<HTMLPreElement>(null);

  const running = task?.status === "running";

  useEffect(() => {
    if (!task || task.status !== "running") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/tasks/${task.id}`);
        if (!res.ok) return;
        const fresh = await res.json();
        setTask({ id: fresh.id, status: fresh.status, logs: fresh.logs ?? "" });
        if (fresh.status !== "running") {
          clearInterval(interval);
          router.refresh();
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.status]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [task?.logs]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4" /> RunPod pod
          </CardTitle>
          {running ? (
            <Badge variant="secondary" className="gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Provisioning
            </Badge>
          ) : task?.status === "failed" ? (
            <Badge variant="destructive">Provisioning failed</Badge>
          ) : (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              Pod ready
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="font-mono">{runpod.podId}</span>
          <span>{runpod.gpuTypeId} ×{runpod.gpuCount}</span>
          <span>{runpod.cloudType} cloud</span>
          <span>{runpod.containerDiskGb} GB container disk (temporary)</span>
          {runpod.volumeGb != null && (
            <span>
              {runpod.volumeGb > 0
                ? `${runpod.volumeGb} GB volume @ ${runpod.volumeMountPath ?? "/workspace"}`
                : "no persistent volume"}
            </span>
          )}
          <a
            href="https://www.runpod.io/console/pods"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            RunPod console ↗
          </a>
        </div>

        {task ? (
          <pre
            ref={logRef}
            className="max-h-56 overflow-y-auto rounded-md border bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap"
          >
            {task.logs || "Waiting for first status update…"}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">No provisioning log recorded for this cluster.</p>
        )}

        {task?.status === "success" && (
          <p className="text-xs text-muted-foreground">
            {runpod.instant ? (
              <>
                The pod is up with Slurm pre-installed and the cluster is{" "}
                <span className="font-medium">ACTIVE</span> — no Bootstrap step needed. You can submit
                jobs now. Deleting this cluster terminates the pod.
              </>
            ) : (
              <>
                The pod accepts SSH from Aura. Use the <span className="font-medium">Bootstrap</span>{" "}
                button above to install Slurm on it. Deleting this cluster terminates the pod.
              </>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
