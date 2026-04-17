"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";

interface AccountingCardProps {
  clusterId: string;
}

interface AccountingState {
  mode: "none" | "slurmdbd" | "unknown";
  type: string;
  enforce: string | null;
  priority: string;
  slurmdbdActive: boolean;
  healthy: boolean;
  latestTask: { id: string; status: string; type: string } | null;
}

export function AccountingCard({ clusterId }: AccountingCardProps) {
  const [state, setState] = useState<AccountingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [currentMode, setCurrentMode] = useState<"none" | "slurmdbd" | "fifo" | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [logDialog, setLogDialog] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logStatus, setLogStatus] = useState<"running" | "success" | "failed">("running");
  const [dialogTitle, setDialogTitle] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  const fetchState = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/clusters/${clusterId}/accounting`);
      if (r.ok) {
        const d = await r.json();
        setState(d);
        if (d.latestTask && d.latestTask.status === "running") {
          const taskMode: "none" | "slurmdbd" | "fifo" =
            d.latestTask.type === "accounting_none" ? "none" :
            d.latestTask.type === "priority_fifo" ? "fifo" : "slurmdbd";
          setCurrentMode(taskMode);
          setDialogTitle(
            taskMode === "none" ? "Disabling accounting" :
            taskMode === "fifo" ? "Switching to FIFO priority" :
            "Enabling slurmdbd accounting"
          );
          attachToTask(d.latestTask.id);
        }
      }
    } catch {} finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

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
          setCurrentMode(null);
          setCurrentTaskId(null);
          setCancelling(false);
          fetchState();
        } else if (t.status === "failed") {
          setLogStatus("failed");
          clearInterval(poll);
          setApplying(false);
          setCurrentMode(null);
          setCurrentTaskId(null);
          setCancelling(false);
          fetchState();
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

  const apply = async (mode: "none" | "slurmdbd" | "fifo") => {
    if (applying && currentTaskId) {
      setLogDialog(true);
      return;
    }
    setCurrentMode(mode);
    setDialogTitle(
      mode === "none" ? "Disabling accounting" :
      mode === "fifo" ? "Switching to FIFO priority" :
      "Enabling slurmdbd accounting"
    );
    const res = await fetch(`/api/clusters/${clusterId}/accounting/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
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

  const statusBadge = () => {
    if (!state) return null;
    if (state.mode === "none") {
      return <Badge className="bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200">Disabled</Badge>;
    }
    if (state.mode === "slurmdbd") {
      return state.slurmdbdActive
        ? <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">slurmdbd (running)</Badge>
        : <Badge variant="destructive">slurmdbd (not running)</Badge>;
    }
    return <Badge variant="outline">Unknown</Badge>;
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Slurm Accounting</span>
            {statusBadge()}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {loading && !state ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : state ? (
            <>
              <div className="space-y-1">
                <div className="text-muted-foreground">
                  Accounting: <code className="font-mono">{state.type}</code>
                  {state.enforce && <> · Enforce=<code className="font-mono">{state.enforce}</code></>}
                </div>
                <div className="text-muted-foreground">
                  Priority: <code className="font-mono">{state.priority}</code>
                  {state.priority === "priority/multifactor" && (
                    <span className="ml-1 text-yellow-600 dark:text-yellow-400">
                      (can leave jobs stuck on <code>Priority</code> when fair-share is zero)
                    </span>
                  )}
                </div>
                {!state.healthy && (
                  <div className="flex items-start gap-2 text-destructive">
                    <AlertCircle className="h-4 w-4 mt-0.5" />
                    <span>
                      slurm.conf expects slurmdbd but it isn&apos;t running. Jobs will fail with{" "}
                      <code className="font-mono">InvalidAccount</code>. Pick a mode below.
                    </span>
                  </div>
                )}
                {state.healthy && state.mode === "none" && (
                  <div className="flex items-start gap-2 text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 mt-0.5" />
                    <span>Jobs submit without account enforcement. No quotas or fair-share.</span>
                  </div>
                )}
                {state.healthy && state.mode === "slurmdbd" && (
                  <div className="flex items-start gap-2 text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 mt-0.5" />
                    <span>slurmdbd active. Accounts are enforced; provisioned users get their own account.</span>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => apply("none")}
                  disabled={applying && currentMode !== "none"}
                  title="Strip AccountingStorage lines, set to accounting_storage/none, restart slurmctld"
                >
                  {applying && currentMode === "none" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {applying && currentMode === "none" ? "Show Progress" : "Disable Accounting"}
                </Button>
                <Button
                  onClick={() => apply("slurmdbd")}
                  disabled={applying && currentMode !== "slurmdbd"}
                  title="Install MariaDB + slurmdbd, wire slurm.conf, register active users"
                >
                  {applying && currentMode === "slurmdbd" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {applying && currentMode === "slurmdbd" ? "Show Progress" : "Enable slurmdbd Accounting"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => apply("fifo")}
                  disabled={applying && currentMode !== "fifo"}
                  title="Set PriorityType=priority/basic — strict FIFO, fixes jobs stuck on Priority."
                >
                  {applying && currentMode === "fifo" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {applying && currentMode === "fifo" ? "Show Progress" : "Use FIFO Priority"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">Unable to read accounting state.</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={logDialog} onOpenChange={setLogDialog}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-8">
              {dialogTitle || "Applying"}
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
    </>
  );
}
