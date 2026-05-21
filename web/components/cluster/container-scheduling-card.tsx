"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2 } from "lucide-react";

interface ContainerSchedulingCardProps {
  clusterId: string;
  clusterType: "BAREMETAL" | "CONTAINER" | string;
  // Initial value of the cluster's allowCrossNodeScheduling flag. Edits
  // PATCH the cluster and trigger a slurm.conf propagate server-side, so
  // the dirty / saving / saved transitions only need to reflect the API
  // round-trip — Slurm's reconfigure is fire-and-forget from here.
  initialAllowCrossNodeScheduling: boolean;
}

export function ContainerSchedulingCard({
  clusterId,
  clusterType,
  initialAllowCrossNodeScheduling,
}: ContainerSchedulingCardProps) {
  const router = useRouter();
  const [allowCrossNode, setAllowCrossNode] = useState(initialAllowCrossNodeScheduling);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = allowCrossNode !== initialAllowCrossNodeScheduling;
  const isContainer = clusterType === "CONTAINER";

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/clusters/${clusterId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowCrossNodeScheduling: allowCrossNode }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Trigger a refetch so the displayed initial value matches the saved
      // state on next render. router.refresh() is the Server Components way.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Cluster Type
          <Badge variant={isContainer ? "default" : "secondary"}>
            {isContainer ? "Container" : "Bare Metal / VM"}
          </Badge>
        </CardTitle>
        <CardDescription>
          {isContainer
            ? "This cluster runs inside containers — supervisord replaces systemd, slurm.conf is pushed via scp instead of NFS. The cluster type is fixed for the lifetime of the cluster."
            : "This cluster runs on bare-metal hosts or VMs with systemd and an NFS-backed mgmt share. The cluster type is fixed for the lifetime of the cluster."}
        </CardDescription>
      </CardHeader>
      {isContainer && (
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-muted/30 p-4">
            <div className="space-y-1">
              <Label htmlFor="ccn-switch" className="cursor-pointer text-base">
                Allow cross-node scheduling
              </Label>
              <p className="text-xs text-muted-foreground">
                When off, Slurm enforces <code>MaxNodes=1</code> on every partition.
                Every job runs entirely inside one container and uses only intra-node
                GPU interconnect (NVLink/NVSwitch).
              </p>
            </div>
            <Switch
              id="ccn-switch"
              checked={allowCrossNode}
              onCheckedChange={setAllowCrossNode}
            />
          </div>

          {allowCrossNode && (
            <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-semibold">Inter-node CCL / MPI latency</p>
                <p className="mt-1">
                  Multi-node collective communications (NCCL, oneCCL, MPI) will route
                  over your container network — typically 10–100× higher latency than
                  NVLink and bottlenecked by the slowest hop in the network path.
                  Only enable if workers have high-speed interconnect (RoCE, InfiniBand)
                  and the workload is communication-tolerant.
                </p>
              </div>
            </div>
          )}

          {dirty && (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAllowCrossNode(initialAllowCrossNodeScheduling);
                  setError(null);
                }}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {saving ? "Saving…" : "Save & Propagate"}
              </Button>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {!dirty && (
            <p className="text-xs text-muted-foreground">
              Changes trigger an immediate <code>slurm.conf</code> re-render and a
              <code>scontrol reconfigure</code> on the controller. Running jobs are
              not affected.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
