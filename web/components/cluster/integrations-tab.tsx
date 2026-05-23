"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Trash2, Loader2, Check, X, FlaskConical, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import type { ExperimentTracker, TrackerBackend } from "@/lib/experiment-trackers/types";

interface Props {
  clusterId: string;
  initialTrackers: ExperimentTracker[];
}

const BACKEND_LABELS: Record<TrackerBackend, string> = {
  mlflow: "MLflow",
  wandb: "Weights & Biases",
  comet: "Comet",
};

export function IntegrationsTab({ clusterId, initialTrackers }: Props) {
  const [trackers, setTrackers] = useState<ExperimentTracker[]>(initialTrackers);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<ExperimentTracker | null>(null);

  // New-tracker form. Phase 1 forces backend to "mlflow"; later phases unlock
  // the rest, but the form structure stays the same — we'd just enable the
  // disabled options and let the backend-specific fields render conditionally.
  const [newName, setNewName] = useState("");
  const [newBackend, setNewBackend] = useState<TrackerBackend>("mlflow");
  const [newUri, setNewUri] = useState("");
  const [newDefaultExperiment, setNewDefaultExperiment] = useState("aura-jobs");

  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "failed">("idle");
  const [testMsg, setTestMsg] = useState("");
  const [creating, setCreating] = useState(false);

  const resetForm = () => {
    setNewName("");
    setNewBackend("mlflow");
    setNewUri("");
    setNewDefaultExperiment("aura-jobs");
    setTestStatus("idle");
    setTestMsg("");
  };
  const resetTest = () => {
    setTestStatus("idle");
    setTestMsg("");
  };

  const canTest = !!newUri && /^https?:\/\//i.test(newUri);
  const canCreate = !!newName.trim() && canTest && testStatus === "ok" && !creating;

  const handleTest = async () => {
    setTestStatus("testing");
    setTestMsg("");
    try {
      const res = await fetch(`/api/clusters/${clusterId}/integrations/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: newBackend, trackingUri: newUri }),
      });
      const data = await res.json();
      if (data.success) {
        setTestStatus("ok");
        setTestMsg(data.message ?? "Connection successful");
      } else {
        setTestStatus("failed");
        setTestMsg(data.error ?? "Test failed");
      }
    } catch {
      setTestStatus("failed");
      setTestMsg("Request failed");
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/integrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          backend: newBackend,
          trackingUri: newUri.trim(),
          defaultExperimentName: newDefaultExperiment.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error ?? "Failed to create tracker");
        return;
      }
      const data = await res.json();
      setTrackers([...trackers, data.tracker]);
      setAddOpen(false);
      resetForm();
    } finally {
      setCreating(false);
    }
  };

  const doRemove = async () => {
    const t = confirmRemove;
    if (!t) return;
    setConfirmRemove(null);
    const res = await fetch(`/api/clusters/${clusterId}/integrations/${t.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error ?? "Failed to remove tracker");
      return;
    }
    setTrackers(trackers.filter((x) => x.id !== t.id));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Tracker
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="h-4 w-4" />
            Experiment Trackers ({trackers.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {trackers.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No experiment trackers configured. Add an MLflow server to auto-link jobs to runs.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Backend</TableHead>
                  <TableHead>Tracking URI</TableHead>
                  <TableHead>Default Experiment</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trackers.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{BACKEND_LABELS[t.backend] ?? t.backend}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      <a
                        href={t.trackingUri}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                      >
                        {t.trackingUri}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {t.defaultExperimentName ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive"
                        title="Remove tracker"
                        onClick={() => setConfirmRemove(t)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add Tracker dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) resetForm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Experiment Tracker</DialogTitle>
            <DialogDescription>
              Submitted jobs get auto-linked to a tracker run; SBATCH wrappers inject
              <code className="mx-1 font-mono">MLFLOW_TRACKING_URI</code>/{" "}
              <code className="font-mono">MLFLOW_RUN_ID</code> so user code logs into
              the right run.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Team MLflow"
              />
            </div>
            <div className="space-y-1">
              <Label>Backend</Label>
              <Select
                value={newBackend}
                onValueChange={(v) => {
                  setNewBackend(v as TrackerBackend);
                  resetTest();
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mlflow">MLflow</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Tracking URI</Label>
              <Input
                value={newUri}
                onChange={(e) => {
                  setNewUri(e.target.value);
                  resetTest();
                }}
                placeholder="https://mlflow.internal"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Self-hosted MLflow URL. For basic auth, embed in URL:{" "}
                <code className="font-mono">https://user:pass@host</code>.
              </p>
            </div>
            <div className="space-y-1">
              <Label>Default Experiment Name</Label>
              <Input
                value={newDefaultExperiment}
                onChange={(e) => setNewDefaultExperiment(e.target.value)}
                placeholder="aura-jobs"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Used when the submitter doesn&apos;t override per-job. Created on the
                MLflow side if missing.
              </p>
            </div>
            {testStatus === "ok" && (
              <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                {testMsg}
              </Badge>
            )}
            {testStatus === "failed" && (
              <p className="whitespace-pre-wrap text-sm text-destructive">{testMsg}</p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="secondary"
              onClick={handleTest}
              disabled={!canTest || testStatus === "testing"}
            >
              {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {testStatus === "ok" && <Check className="mr-2 h-4 w-4 text-green-600" />}
              {testStatus === "failed" && <X className="mr-2 h-4 w-4 text-destructive" />}
              {testStatus === "testing" ? "Testing..." : "Test Connection"}
            </Button>
            <Button onClick={handleCreate} disabled={!canCreate}>
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add Tracker
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirmation */}
      <Dialog open={!!confirmRemove} onOpenChange={(o) => { if (!o) setConfirmRemove(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove tracker?</DialogTitle>
            <DialogDescription>
              Removes <strong>{confirmRemove?.name}</strong> from this cluster. Existing
              jobs already linked to this tracker keep their deep links but new jobs
              won&apos;t be auto-linked. The MLflow server itself is not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={doRemove}>
              <Trash2 className="mr-2 h-4 w-4" />
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
