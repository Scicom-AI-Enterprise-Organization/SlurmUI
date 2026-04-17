"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Plus, Trash2, Loader2, Play, Eye, EyeOff, RefreshCw } from "lucide-react";
import { toast } from "sonner";

interface EnvVar {
  key: string;
  value: string;
  secret?: boolean;
}

interface EnvironmentTabProps {
  clusterId: string;
}

const MASK = "********";

export function EnvironmentTab({ clusterId }: EnvironmentTabProps) {
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const [addOpen, setAddOpen] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newSecret, setNewSecret] = useState(false);

  const [applying, setApplying] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const [perHostStatus, setPerHostStatus] = useState<Record<string, Record<string, boolean>>>({});
  const [targets, setTargets] = useState<string[]>([]);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [logDialog, setLogDialog] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logStatus, setLogStatus] = useState<"running" | "success" | "failed">("running");
  const logRef = useRef<HTMLDivElement>(null);

  const fetchData = async () => {
    const r = await fetch(`/api/clusters/${clusterId}/environment`);
    if (r.ok) {
      const d = await r.json();
      setVars(d.vars ?? []);
      if (d.latestTask && d.latestTask.status === "running") {
        attachToTask(d.latestTask.id);
      }
    }
    setLoaded(true);
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  const fetchStatuses = async () => {
    if (vars.length === 0) {
      setPerHostStatus({});
      setTargets([]);
      return;
    }
    setCheckingStatus(true);
    try {
      const r = await fetch(`/api/clusters/${clusterId}/environment/status`, { method: "POST" });
      if (r.ok) {
        const d = await r.json();
        setPerHostStatus(d.perHost ?? {});
        setTargets(d.targets ?? []);
      }
    } catch {}
    finally {
      setCheckingStatus(false);
    }
  };

  useEffect(() => {
    fetchStatuses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vars.length, clusterId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const persist = async (next: EnvVar[]) => {
    const res = await fetch(`/api/clusters/${clusterId}/environment`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vars: next }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      toast.error(err.error ?? "Failed to save");
      return false;
    }
    const d = await res.json();
    setVars(d.vars ?? next);
    return true;
  };

  const handleAdd = async () => {
    const key = newKey.trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      toast.error("Invalid env var name");
      return;
    }
    if (vars.some((v) => v.key === key)) {
      toast.error(`${key} already exists`);
      return;
    }
    const next = [...vars, { key, value: newValue, secret: newSecret }];
    if (await persist(next)) {
      setNewKey("");
      setNewValue("");
      setNewSecret(false);
      setAddOpen(false);
    }
  };

  const handleRemove = async (key: string) => {
    await persist(vars.filter((v) => v.key !== key));
  };

  const attachToTask = (taskId: string) => {
    setApplying(true);
    setCurrentTaskId(taskId);
    setLogLines([]);
    setLogStatus("running");
    setLogDialog(true);
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}`);
        if (!r.ok) return;
        const t = await r.json();
        setLogLines(t.logs ? t.logs.split("\n") : []);
        if (t.status === "success") {
          setLogStatus("success");
          clearInterval(poll);
          setApplying(false);
          setCurrentTaskId(null);
          setCancelling(false);
          fetchStatuses();
        } else if (t.status === "failed") {
          setLogStatus("failed");
          clearInterval(poll);
          setApplying(false);
          setCurrentTaskId(null);
          setCancelling(false);
          fetchStatuses();
        }
      } catch {}
    }, 2000);
  };

  const handleCancel = async () => {
    if (!currentTaskId) return;
    setCancelling(true);
    try {
      await fetch(`/api/tasks/${currentTaskId}/cancel`, { method: "POST" });
    } catch {
      setCancelling(false);
    }
  };

  const handleApply = async () => {
    if (applying && currentTaskId) {
      setLogDialog(true);
      return;
    }
    const res = await fetch(`/api/clusters/${clusterId}/environment/apply`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setLogLines([`[error] ${err.error ?? "Failed to start"}`]);
      setLogStatus("failed");
      setLogDialog(true);
      return;
    }
    const { taskId } = await res.json();
    attachToTask(taskId);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          onClick={fetchStatuses}
          disabled={vars.length === 0 || checkingStatus}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${checkingStatus ? "animate-spin" : ""}`} />
          Refresh Status
        </Button>
        <Button
          variant="outline"
          onClick={handleApply}
          disabled={!applying && vars.length === 0}
          title="Write /etc/profile.d/aura.sh on every node"
        >
          {applying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          {applying ? "Show Progress" : "Apply to Cluster"}
        </Button>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Variable
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Environment Variables ({vars.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {!loaded ? (
            <p className="text-center text-muted-foreground py-6">Loading...</p>
          ) : vars.length === 0 ? (
            <p className="text-center text-muted-foreground py-6">
              No variables yet. Add variables that every node should have in its login environment
              (e.g. <code>HF_TOKEN</code>, <code>WANDB_API_KEY</code>, <code>HTTP_PROXY</code>).
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead className="w-[100px]">Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[120px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vars.map((v) => {
                  const isMasked = v.secret && v.value === MASK;
                  const isShown = !!revealed[v.key];

                  let statusBadge: React.ReactNode = null;
                  if (targets.length > 0) {
                    const total = targets.length;
                    const applied = targets.filter((h) => perHostStatus[h]?.[v.key]).length;
                    if (applied === total) {
                      statusBadge = (
                        <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                          Applied ({applied}/{total})
                        </Badge>
                      );
                    } else if (applied === 0) {
                      statusBadge = (
                        <Badge variant="outline" className="text-muted-foreground">
                          Not applied (0/{total})
                        </Badge>
                      );
                    } else {
                      statusBadge = (
                        <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                          Partial ({applied}/{total})
                        </Badge>
                      );
                    }
                  } else {
                    statusBadge = <span className="text-xs text-muted-foreground">—</span>;
                  }

                  return (
                    <TableRow key={v.key}>
                      <TableCell className="font-mono text-sm">{v.key}</TableCell>
                      <TableCell className="font-mono text-sm break-all">
                        {v.secret ? (isShown ? v.value : MASK) : v.value || <span className="text-muted-foreground">(empty)</span>}
                      </TableCell>
                      <TableCell>
                        {v.secret ? (
                          <Badge variant="outline">Secret</Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">Plain</Badge>
                        )}
                      </TableCell>
                      <TableCell>{statusBadge}</TableCell>
                      <TableCell>
                        {v.secret && !isMasked && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={isShown ? "Hide value" : "Reveal value"}
                            onClick={() => setRevealed((r) => ({ ...r, [v.key]: !r[v.key] }))}
                          >
                            {isShown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive"
                          title="Remove variable"
                          onClick={() => handleRemove(v.key)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add Variable Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Environment Variable</DialogTitle>
            <DialogDescription>
              Gets written to <code>/etc/profile.d/aura.sh</code> on every node when you click
              Apply. Available in every login shell and <code>sbatch</code> job.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="env-key">Name</Label>
              <Input
                id="env-key"
                placeholder="e.g. HF_TOKEN, WANDB_API_KEY, HTTP_PROXY"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="env-value">Value</Label>
              <Input
                id="env-value"
                type={newSecret ? "password" : "text"}
                placeholder="Value"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="env-secret"
                checked={newSecret}
                onCheckedChange={(c) => setNewSecret(!!c)}
              />
              <Label htmlFor="env-secret" className="font-normal">
                Secret (mask value in UI, redact from cluster config responses)
              </Label>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleAdd} disabled={!newKey.trim()}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Log Dialog */}
      <Dialog open={logDialog} onOpenChange={setLogDialog}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-8">
              Applying Environment
              <Badge className={
                logStatus === "running" ? "bg-blue-100 text-blue-800" :
                logStatus === "success" ? "bg-green-100 text-green-800" :
                "bg-red-100 text-red-800"
              }>
                {logStatus === "running" ? "Running" : logStatus === "success" ? "Success" : "Failed"}
              </Badge>
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
                  line.startsWith("[error]") ? "text-red-400" :
                  line.startsWith("[aura]") ? "text-cyan-400" : ""
                }`}
              >
                {line || "\u00A0"}
              </div>
            ))}
            {logStatus === "running" && (
              <div className="mt-1 inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Running...
              </div>
            )}
          </div>
          <DialogFooter>
            {logStatus === "running" ? (
              <Button variant="destructive" onClick={handleCancel} disabled={cancelling || !currentTaskId}>
                {cancelling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {cancelling ? "Cancelling..." : "Cancel"}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setLogDialog(false)}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
