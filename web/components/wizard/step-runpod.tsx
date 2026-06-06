"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import type { SshKeyOption } from "@/components/wizard/step-basics";

// Mirrors DEFAULT_RUNPOD_IMAGE in lib/gpu-provider.ts (server-side) — kept
// inline so the server lib doesn't land in the client bundle.
const DEFAULT_RUNPOD_IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";

export interface RunpodBasics {
  clusterName: string;
  gpuProviderId: string;
  gpuTypeId: string;
  gpuCount: string;
  cloudType: "COMMUNITY" | "SECURE";
  containerDiskGb: string;
  volumeGb: string;
  volumeMountPath: string;
  imageName: string;
  sshKeyId: string;
}

export const RUNPOD_DEFAULTS: Omit<RunpodBasics, "gpuProviderId" | "sshKeyId"> = {
  clusterName: "",
  gpuTypeId: "",
  gpuCount: "1",
  cloudType: "COMMUNITY",
  containerDiskGb: "50",
  volumeGb: "50",
  volumeMountPath: "/workspace",
  imageName: DEFAULT_RUNPOD_IMAGE,
};

export interface GpuProviderOption {
  id: string;
  name: string;
}

interface GpuTypeOption {
  id: string;
  displayName: string;
  memoryInGb: number | null;
  stockStatus: string | null;
  pricePerHr: number | null;
}

interface StepRunpodProps {
  data: RunpodBasics;
  onChange: (data: RunpodBasics) => void;
  gpuProviders: GpuProviderOption[];
  sshKeys: SshKeyOption[];
  // true = Instant Cluster (pre-baked slurm-node image, no image field, no
  // Bootstrap). false/undefined = legacy RunPod GPU pod (editable image + manual
  // Bootstrap).
  instant?: boolean;
}

export function StepRunpod({ data, onChange, gpuProviders, sshKeys, instant = false }: StepRunpodProps) {
  const [gpuTypes, setGpuTypes] = useState<GpuTypeOption[]>([]);
  const [gpusLoading, setGpusLoading] = useState(false);
  const [gpusError, setGpusError] = useState<string | null>(null);

  const update = (field: keyof RunpodBasics, value: string) => {
    onChange({ ...data, [field]: value });
  };

  // Live GPU catalogue (stock + price) for the selected provider account.
  useEffect(() => {
    if (!data.gpuProviderId) { setGpuTypes([]); return; }
    let cancelled = false;
    setGpusLoading(true);
    setGpusError(null);
    fetch(`/api/admin/gpu-providers/${data.gpuProviderId}/gpus`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) { setGpusError(body.error ?? `HTTP ${res.status}`); return; }
        const sorted = (body as GpuTypeOption[]).sort((a, b) => {
          const stockDiff = Number(!!b.stockStatus) - Number(!!a.stockStatus);
          return stockDiff !== 0 ? stockDiff : a.displayName.localeCompare(b.displayName);
        });
        setGpuTypes(sorted);
      })
      .catch(() => { if (!cancelled) setGpusError("Request failed"); })
      .finally(() => { if (!cancelled) setGpusLoading(false); });
    return () => { cancelled = true; };
  }, [data.gpuProviderId]);

  if (gpuProviders.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No GPU providers configured</CardTitle>
          <CardDescription>
            Connect a RunPod account first, then come back here to rent a pod.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/admin/gpu-providers/new" className="text-sm text-primary underline-offset-4 hover:underline">
            Add a GPU provider →
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
          <CardDescription>How this cluster is named.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rp-clusterName">Cluster Name</Label>
            <Input
              id="rp-clusterName"
              placeholder="runpod-cluster-01"
              value={data.clusterName}
              onChange={(e) => update("clusterName", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Unique identifier. Lowercase and hyphens only. The RunPod pod is named after it.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{instant ? "Instant cluster pod" : "RunPod pod"}</CardTitle>
          <CardDescription>
            {instant
              ? "We rent one GPU pod that is the whole cluster. The image already has Slurm, munge and accounting set up, so once the pod boots you can submit jobs. No Bootstrap step. The controller and worker are the same node."
              : "We rent one pod and use it as the whole cluster. The controller and worker are the same node."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Provider account</Label>
              <Select
                value={data.gpuProviderId}
                onValueChange={(v) => onChange({ ...data, gpuProviderId: v, gpuTypeId: "" })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a RunPod account" />
                </SelectTrigger>
                <SelectContent>
                  {gpuProviders.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>GPU type</Label>
              <Select
                value={data.gpuTypeId}
                onValueChange={(v) => update("gpuTypeId", v)}
                disabled={!data.gpuProviderId || gpusLoading}
              >
                <SelectTrigger className="w-full">
                  {gpusLoading
                    ? <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading catalogue…</span>
                    : <SelectValue placeholder={data.gpuProviderId ? "Select a GPU" : "Pick a provider first"} />}
                </SelectTrigger>
                <SelectContent>
                  {gpuTypes.map((g) => (
                    <SelectItem key={g.id} value={g.id} disabled={!g.stockStatus}>
                      {g.displayName}
                      {g.memoryInGb != null ? ` · ${g.memoryInGb} GB` : ""}
                      {g.pricePerHr != null ? ` · $${g.pricePerHr.toFixed(2)}/hr` : ""}
                      {!g.stockStatus ? " · out of stock" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {gpusError && <p className="text-xs text-destructive">{gpusError}</p>}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rp-gpuCount">GPU count</Label>
              <Input
                id="rp-gpuCount"
                type="number"
                min={1}
                max={8}
                value={data.gpuCount}
                onChange={(e) => update("gpuCount", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Cloud type</Label>
              {instant ? (
                <>
                  <div className="flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm text-muted-foreground">
                    Secure (verified hosts)
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Instant clusters always use Secure cloud and a host with CUDA&nbsp;12.8 or newer,
                    since the image ships CUDA&nbsp;12.8.
                  </p>
                </>
              ) : (
                <Select value={data.cloudType} onValueChange={(v) => update("cloudType", v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="COMMUNITY">Community (cheaper)</SelectItem>
                    <SelectItem value="SECURE">Secure (verified hosts)</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {/* RunPod pods have two disks — make the temporary/persistent split obvious. */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="rp-disk">Container disk (GB)</Label>
              <Input
                id="rp-disk"
                type="number"
                min={10}
                max={1000}
                value={data.containerDiskGb}
                onChange={(e) => update("containerDiskGb", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Temporary storage, wiped every time the pod restarts. Holds the OS and anything
                outside the volume mount.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rp-volume">Volume disk (GB)</Label>
              <Input
                id="rp-volume"
                type="number"
                min={0}
                max={4000}
                value={data.volumeGb}
                onChange={(e) => update("volumeGb", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Persistent storage that survives pod restarts. Set 0 for no volume.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rp-volume-mount">Volume mount path</Label>
              <Input
                id="rp-volume-mount"
                placeholder="/workspace"
                value={data.volumeMountPath}
                onChange={(e) => update("volumeMountPath", e.target.value)}
                disabled={(parseInt(data.volumeGb) || 0) === 0}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Where the volume is mounted inside the pod. Keep data you care about under this path.
              </p>
            </div>
          </div>

          {instant ? (
            <p className="text-xs text-muted-foreground">
              The pod runs SlurmUI&apos;s pre-baked Slurm image, picked for you. On boot it starts SSH,
              trusts the key below, and sets up Slurm by itself, so there&apos;s no Bootstrap step.
            </p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="rp-image">Image</Label>
              <Input
                id="rp-image"
                value={data.imageName}
                onChange={(e) => update("imageName", e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                The Docker image the pod runs. Keep the default unless you know what you&apos;re doing —
                RunPod&apos;s official images start an SSH server on boot and install the key Aura sends,
                which is how Aura gets access to the pod. A custom image without that can never be
                reached.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>SSH access</CardTitle>
          <CardDescription>
            Aura manages the cluster by logging into the pod over SSH. Pick which of your SSH keys
            it should use. When the pod boots, RunPod authorises that key for you, so there&apos;s
            nothing to set up on the pod and no &quot;Test SSH&quot; step here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label>SSH Key</Label>
          <Select value={data.sshKeyId} onValueChange={(v) => update("sshKeyId", v)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select an SSH key" />
            </SelectTrigger>
            <SelectContent>
              {sshKeys.map((key) => (
                <SelectItem key={key.id} value={key.id}>{key.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Only the key&apos;s public half is sent to RunPod; the private half never leaves Aura.
            Manage keys in Settings → SSH Keys.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
