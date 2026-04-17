"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Plus, Trash2, Package, Loader2, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";

interface PackagesTabProps {
  clusterId: string;
}

export function PackagesTab({ clusterId }: PackagesTabProps) {
  const router = useRouter();
  const [packages, setPackages] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newPackage, setNewPackage] = useState("");

  const [installing, setInstalling] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [logDialog, setLogDialog] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logStatus, setLogStatus] = useState<"running" | "success" | "failed">("running");
  const logRef = useRef<HTMLDivElement>(null);

  // Install status per package across nodes
  const [pkgStatuses, setPkgStatuses] = useState<Record<string, Record<string, string>>>({});
  const [targetHosts, setTargetHosts] = useState<string[]>([]);
  const [checkingStatus, setCheckingStatus] = useState(false);

  const fetchStatuses = async () => {
    if (packages.length === 0) {
      setPkgStatuses({});
      return;
    }
    setCheckingStatus(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/packages/status`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setPkgStatuses(data.statuses ?? {});
        setTargetHosts(data.targets ?? []);
      }
    } catch {} finally {
      setCheckingStatus(false);
    }
  };

  useEffect(() => {
    fetchStatuses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packages.length, clusterId]);

  // Fetch installed packages on mount + re-attach to an in-progress install.
  useEffect(() => {
    fetch(`/api/clusters/${clusterId}/packages`)
      .then((r) => r.json())
      .then((d) => {
        setPackages(d.packages ?? []);
        setLoaded(true);
        if (d.latestTask && d.latestTask.status === "running") {
          attachToTask(d.latestTask.id);
        }
      })
      .catch(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  const attachToTask = (taskId: string) => {
    setInstalling(true);
    setCurrentTaskId(taskId);
    setLogLines([]);
    setLogStatus("running");
    setLogDialog(true);
    const poll = setInterval(async () => {
      try {
        const taskRes = await fetch(`/api/tasks/${taskId}`);
        if (!taskRes.ok) return;
        const task = await taskRes.json();
        setLogLines(task.logs ? task.logs.split("\n") : []);
        if (task.status === "success") {
          setLogStatus("success");
          clearInterval(poll);
          setInstalling(false);
          setCurrentTaskId(null);
          setCancelling(false);
          fetchStatuses();
        } else if (task.status === "failed") {
          setLogStatus("failed");
          clearInterval(poll);
          setInstalling(false);
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

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const persistPackages = async (updated: string[]) => {
    await fetch(`/api/clusters/${clusterId}/packages`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packages: updated }),
    });
  };

  const handleAdd = async () => {
    const name = newPackage.trim().toLowerCase();
    if (!name || packages.includes(name)) return;
    const updated = [...packages, name];
    setPackages(updated);
    setNewPackage("");
    setAddOpen(false);
    await persistPackages(updated);
  };

  const handleRemove = async (pkg: string) => {
    const updated = packages.filter((p) => p !== pkg);
    setPackages(updated);
    await persistPackages(updated);
  };

  const handleInstallAll = async () => {
    // Re-open the log dialog if an install is already in flight.
    if (installing && currentTaskId) {
      setLogDialog(true);
      return;
    }
    if (packages.length === 0) return;

    try {
      const res = await fetch(`/api/clusters/${clusterId}/packages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packages }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setLogStatus("failed");
        setLogLines([`[error] ${err.error ?? "Failed to start installation"}`]);
        setLogDialog(true);
        return;
      }

      const data = await res.json();

      if (data.taskId) {
        attachToTask(data.taskId);
      } else if (data.request_id) {
        // NATS mode: open SSE (no cancel wiring yet)
        setInstalling(true);
        setLogLines([]);
        setLogStatus("running");
        setLogDialog(true);
        const evt = new EventSource(`/api/clusters/${clusterId}/stream/${data.request_id}`);
        evt.onmessage = (e) => {
          try {
            const ev = JSON.parse(e.data);
            if (ev.type === "stream") {
              setLogLines((prev) => [...prev, ev.line]);
            } else if (ev.type === "complete") {
              setLogStatus(ev.success ? "success" : "failed");
              evt.close();
              setInstalling(false);
            }
          } catch {}
        };
        evt.onerror = () => {
          setLogStatus("failed");
          evt.close();
          setInstalling(false);
        };
      }
    } catch {
      setLogStatus("failed");
      setLogLines(["[error] Request failed"]);
      setLogDialog(true);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          onClick={fetchStatuses}
          disabled={packages.length === 0 || checkingStatus}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${checkingStatus ? "animate-spin" : ""}`} />
          Refresh Status
        </Button>
        <Button
          variant="outline"
          onClick={handleInstallAll}
          disabled={!installing && packages.length === 0}
        >
          {installing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          {installing ? "Show Progress" : "Install All"}
        </Button>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Package
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Packages ({packages.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!loaded ? (
            <p className="text-center text-muted-foreground py-6">Loading...</p>
          ) : packages.length === 0 ? (
            <p className="text-center text-muted-foreground py-6">
              No packages configured. Add apt packages to install on all cluster nodes.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[120px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {packages.map((pkg) => {
                  const status = pkgStatuses[pkg] ?? {};
                  const totalTargets = targetHosts.length;
                  const installedCount = Object.values(status).filter((s) => s === "installed").length;
                  return (
                  <TableRow key={pkg}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-mono text-sm">
                        <Package className="h-3 w-3 text-muted-foreground" />
                        {pkg}
                      </div>
                    </TableCell>
                    <TableCell>
                      {totalTargets === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : installedCount === totalTargets ? (
                        <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                          Installed ({installedCount}/{totalTargets})
                        </Badge>
                      ) : installedCount === 0 ? (
                        <Badge variant="outline" className="text-muted-foreground">
                          Not installed
                        </Badge>
                      ) : (
                        <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                          Partial ({installedCount}/{totalTargets})
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive"
                        title="Remove package"
                        onClick={() => handleRemove(pkg)}
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

      {/* Add Package Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Package</DialogTitle>
            <DialogDescription>
              Package will be installed via <code>apt</code> on all cluster nodes when you click Install All.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pkg-name">Package Name</Label>
            <Input
              id="pkg-name"
              placeholder="e.g. htop, nvtop, python3-scipy"
              value={newPackage}
              onChange={(e) => setNewPackage(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newPackage.trim()) handleAdd(); }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={handleAdd}
              disabled={!newPackage.trim() || packages.includes(newPackage.trim().toLowerCase())}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Install Log Dialog */}
      <Dialog open={logDialog} onOpenChange={setLogDialog}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-8">
              Installing Packages
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
                {cancelling ? "Cancelling..." : "Cancel Installation"}
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
