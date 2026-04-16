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
import { Plus, Trash2, Package, Loader2, Play } from "lucide-react";
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
  const [logDialog, setLogDialog] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logStatus, setLogStatus] = useState<"running" | "success" | "failed">("running");
  const logRef = useRef<HTMLDivElement>(null);

  // Fetch installed packages on mount
  useEffect(() => {
    fetch(`/api/clusters/${clusterId}/packages`)
      .then((r) => r.json())
      .then((d) => {
        setPackages(d.packages ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [clusterId]);

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
    if (packages.length === 0) return;
    setInstalling(true);
    setLogLines([]);
    setLogStatus("running");
    setLogDialog(true);

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
        return;
      }

      const data = await res.json();

      if (data.taskId) {
        // Poll the background task
        const poll = setInterval(async () => {
          try {
            const taskRes = await fetch(`/api/tasks/${data.taskId}`);
            if (!taskRes.ok) return;
            const task = await taskRes.json();
            setLogLines(task.logs ? task.logs.split("\n") : []);
            if (task.status === "success") {
              setLogStatus("success");
              clearInterval(poll);
            } else if (task.status === "failed") {
              setLogStatus("failed");
              clearInterval(poll);
            }
          } catch {}
        }, 2000);
      } else if (data.request_id) {
        // NATS mode: open SSE
        const evt = new EventSource(`/api/clusters/${clusterId}/stream/${data.request_id}`);
        evt.onmessage = (e) => {
          try {
            const ev = JSON.parse(e.data);
            if (ev.type === "stream") {
              setLogLines((prev) => [...prev, ev.line]);
            } else if (ev.type === "complete") {
              setLogStatus(ev.success ? "success" : "failed");
              evt.close();
            }
          } catch {}
        };
        evt.onerror = () => {
          setLogStatus("failed");
          evt.close();
        };
      }
    } catch {
      setLogStatus("failed");
      setLogLines(["[error] Request failed"]);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          onClick={handleInstallAll}
          disabled={packages.length === 0 || installing}
        >
          {installing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          Install All
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
                  <TableHead className="w-[120px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {packages.map((pkg) => (
                  <TableRow key={pkg}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-mono text-sm">
                        <Package className="h-3 w-3 text-muted-foreground" />
                        {pkg}
                      </div>
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
                ))}
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
      <Dialog open={logDialog} onOpenChange={logStatus !== "running" ? setLogDialog : undefined}>
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
          {logStatus !== "running" && (
            <Button variant="outline" onClick={() => setLogDialog(false)}>Close</Button>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
