"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StepBasics, type ClusterBasics, type SshKeyOption, type SshTestStatus } from "@/components/wizard/step-basics";
import { StepRunpod, RUNPOD_DEFAULTS, type RunpodBasics, type GpuProviderOption } from "@/components/wizard/step-runpod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Loader2, Server, Cpu, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

// "runpod" = legacy bare GPU pod (manual Bootstrap). "instant" = pre-baked
// slurm-node image, ready without Bootstrap. Both post to /api/clusters/runpod.
type HostSource = "ssh" | "runpod" | "instant";

interface NewClusterWizardProps {
  sshKeys: SshKeyOption[];
  gpuProviders: GpuProviderOption[];
}

export function NewClusterWizard({ sshKeys, gpuProviders }: NewClusterWizardProps) {
  const router = useRouter();
  const [source, setSource] = useState<HostSource>("ssh");
  const [basics, setBasics] = useState<ClusterBasics>({
    clusterName: "",
    controllerHost: "",
    sshUser: "root",
    sshPort: "22",
    sshKeyId: sshKeys.length === 1 ? sshKeys[0].id : "",
    sshJumpHost: "",
    sshJumpUser: "root",
    sshJumpPort: "22",
    sshJumpKeyId: "",
    sshProxyCommand: "",
    sshJumpProxyCommand: "",
  });
  const [runpod, setRunpod] = useState<RunpodBasics>({
    ...RUNPOD_DEFAULTS,
    gpuProviderId: gpuProviders.length === 1 ? gpuProviders[0].id : "",
    sshKeyId: sshKeys.length === 1 ? sshKeys[0].id : "",
  });
  const [creating, setCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sshTestStatus, setSshTestStatus] = useState<SshTestStatus>("idle");

  // RunPod provisioning progress (after the pod + cluster are created).
  const [provisioning, setProvisioning] = useState<{ clusterId: string; taskId: string } | null>(null);
  const [provisionLogs, setProvisionLogs] = useState("");
  const [provisionFailed, setProvisionFailed] = useState(false);
  const logBoxRef = useRef<HTMLPreElement>(null);

  const canCreate = source === "ssh"
    ? !!(basics.clusterName && basics.controllerHost && basics.sshKeyId && sshTestStatus === "ok")
    : !!(runpod.clusterName && runpod.gpuProviderId && runpod.gpuTypeId && runpod.sshKeyId);

  const handleCreate = async () => {
    setCreating(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/clusters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: basics.clusterName,
          controllerHost: basics.controllerHost,
          connectionMode: "SSH",
          sshKeyId: basics.sshKeyId,
          sshUser: basics.sshUser || "root",
          sshPort: parseInt(basics.sshPort) || 22,
          sshJumpHost: basics.sshJumpHost || undefined,
          sshJumpUser: basics.sshJumpHost ? (basics.sshJumpUser || "root") : undefined,
          sshJumpPort: basics.sshJumpHost ? (parseInt(basics.sshJumpPort) || 22) : undefined,
          sshJumpKeyId: basics.sshJumpHost && basics.sshJumpKeyId ? basics.sshJumpKeyId : undefined,
          sshProxyCommand: basics.sshProxyCommand || undefined,
          sshJumpProxyCommand: basics.sshJumpProxyCommand || undefined,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text();
        let msg: string;
        try {
          const err = JSON.parse(bodyText);
          msg = err.error ?? `HTTP ${res.status}`;
        } catch {
          // Non-JSON response (Next.js 500 HTML page, for instance) — show a
          // truncated excerpt so the real error isn't hidden.
          msg = `HTTP ${res.status}: ${bodyText.slice(0, 300)}`;
        }
        setErrorMsg(msg);
        return;
      }
      const cluster = await res.json();
      router.push(`/admin/clusters/${cluster.id}/configuration`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to create cluster. Please check your connection and try again.");
    } finally {
      setCreating(false);
    }
  };

  const handleCreateRunpod = async () => {
    setCreating(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/clusters/runpod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: runpod.clusterName,
          gpuProviderId: runpod.gpuProviderId,
          gpuTypeId: runpod.gpuTypeId,
          gpuCount: parseInt(runpod.gpuCount) || 1,
          // Instant clusters are forced to Secure cloud (the server also enforces
          // this + a CUDA 12.8+ host filter).
          cloudType: source === "instant" ? "SECURE" : runpod.cloudType,
          containerDiskGb: parseInt(runpod.containerDiskGb) || 50,
          volumeGb: parseInt(runpod.volumeGb) || 0,
          volumeMountPath: runpod.volumeMountPath || "/workspace",
          // Instant: server launches the pre-baked slurm-node image (Slurm up on
          // boot) and marks the cluster ACTIVE — no Bootstrap, image chosen
          // server-side. Legacy "runpod" tile keeps the bare pod + manual
          // Bootstrap and passes the user-chosen image.
          instant: source === "instant",
          ...(source === "instant" ? {} : { imageName: runpod.imageName }),
          sshKeyId: runpod.sshKeyId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(data.error ?? `HTTP ${res.status}`);
        return;
      }
      // Pod is rented; follow the provisioning task until SSH is live.
      setProvisioning({ clusterId: data.id, taskId: data.taskId });
      setProvisionLogs("");
      setProvisionFailed(false);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to create cluster. Please check your connection and try again.");
    } finally {
      setCreating(false);
    }
  };

  // Poll the provisioning task; land on the Configuration tab once SSH is
  // verified so the user can run Bootstrap.
  useEffect(() => {
    if (!provisioning || provisionFailed) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/tasks/${provisioning.taskId}`);
        if (!res.ok) return;
        const task = await res.json();
        setProvisionLogs(task.logs ?? "");
        if (task.status === "success") {
          clearInterval(interval);
          router.push(`/admin/clusters/${provisioning.clusterId}/configuration`);
        } else if (task.status === "failed") {
          clearInterval(interval);
          setProvisionFailed(true);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [provisioning, provisionFailed, router]);

  // Keep the log box pinned to the latest line.
  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [provisionLogs]);

  if (provisioning) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            {provisionFailed
              ? <span className="text-destructive">Provisioning failed</span>
              : <><Loader2 className="h-4 w-4 animate-spin" /> Renting RunPod pod…</>}
          </div>
          <pre
            ref={logBoxRef}
            className="max-h-72 overflow-y-auto rounded bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap"
          >
            {provisionLogs || "Waiting for first status update…"}
          </pre>
          <p className="text-xs text-muted-foreground">
            The cluster is created — you can leave this page; provisioning continues in the background.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => router.push(`/admin/clusters/${provisioning.clusterId}/configuration`)}
          >
            Open cluster
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {/* Host source */}
        <div className="grid gap-4 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => setSource("ssh")}
            className={cn(
              "rounded-lg border p-4 text-left transition-colors hover:border-primary/60",
              source === "ssh" ? "border-primary ring-1 ring-primary" : "border-border",
            )}
          >
            <div className="flex items-center gap-2 font-medium">
              <Server className="h-4 w-4" /> Existing host
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              A machine you already have SSH access to.
            </p>
          </button>
          <button
            type="button"
            onClick={() => setSource("runpod")}
            className={cn(
              "rounded-lg border p-4 text-left transition-colors hover:border-primary/60",
              source === "runpod" ? "border-primary ring-1 ring-primary" : "border-border",
            )}
          >
            <div className="flex items-center gap-2 font-medium">
              <Cpu className="h-4 w-4" /> RunPod GPU pod
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Rent a GPU pod from a connected provider — single node for now.
            </p>
          </button>
          <button
            type="button"
            onClick={() => setSource("instant")}
            className={cn(
              "instant-glow rounded-lg p-4 text-left transition-transform duration-200 hover:-translate-y-0.5",
              source === "instant" ? "ring-2 ring-primary/70" : "",
            )}
          >
            <div className="flex items-center gap-2 font-semibold">
              <Zap className="h-4 w-4 text-fuchsia-500" />
              Instant Cluster
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              A GPU pod that boots fully cluster-ready within minutes, zero bootstrap required
            </p>
          </button>
        </div>

        {source === "ssh" ? (
          <StepBasics data={basics} onChange={setBasics} sshKeys={sshKeys} onSshTestChange={setSshTestStatus} />
        ) : (
          <StepRunpod data={runpod} onChange={setRunpod} gpuProviders={gpuProviders} sshKeys={sshKeys} instant={source === "instant"} />
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => router.push("/admin/clusters")}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button
            onClick={source === "ssh" ? handleCreate : handleCreateRunpod}
            disabled={!canCreate || creating}
          >
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {creating ? "Creating..." : "Create Cluster"}
          </Button>
        </div>
      </div>

      <Dialog open={!!errorMsg} onOpenChange={(open) => { if (!open) setErrorMsg(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
            <DialogDescription>{errorMsg}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button>OK</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
