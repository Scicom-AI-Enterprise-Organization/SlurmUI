"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { GitCommit, Loader2 } from "lucide-react";

interface Props {
  clusterId: string;
}

export function GitopsOnlyCard({ clusterId }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/clusters/${clusterId}/gitops-only`)
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d) => setEnabled(!!d.enabled))
      .finally(() => setLoading(false));
  }, [clusterId]);

  const toggle = async (next: boolean) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/gitops-only`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(d.error ?? `Failed (${res.status})`);
        return;
      }
      setEnabled(d.enabled);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCommit className="h-4 w-4" />
          GitOps-only jobs
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          When enabled, the UI and REST endpoints refuse to submit jobs to this cluster.
          The only accepted source is the <b>Git Jobs</b> reconciler (manifest commit →
          sbatch). Existing jobs keep running and can still be cancelled from the UI.
        </p>
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label htmlFor={`gitops-only-${clusterId}`} className="font-medium">
              Enforce 100% GitOps
            </Label>
            <p className="text-xs text-muted-foreground">
              Requires Git Jobs to be enabled under Settings → Git Jobs. Otherwise
              nothing will ever submit and this cluster will sit idle.
            </p>
          </div>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              id={`gitops-only-${clusterId}`}
              checked={enabled}
              disabled={saving}
              onCheckedChange={toggle}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
