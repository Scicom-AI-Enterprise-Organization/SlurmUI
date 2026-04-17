"use client";

import { useEffect, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, Loader2, Play, Package, RefreshCw } from "lucide-react";
import { toast } from "sonner";

interface StorageMount {
  id: string;
  mountPath: string;
  type: string;
}

interface PythonPackage {
  name: string;
  indexUrl?: string;
  extraIndexUrl?: string;
}

interface PythonPackagesTabProps {
  clusterId: string;
}

export function PythonPackagesTab({ clusterId }: PythonPackagesTabProps) {
  const [packages, setPackages] = useState<PythonPackage[]>([]);
  const [venvLocation, setVenvLocation] = useState<string>("");
  const [pythonVersion, setPythonVersion] = useState<string>("3.12");
  const [installMode, setInstallMode] = useState<"shared" | "per-node">("shared");
  const [localVenvPath, setLocalVenvPath] = useState<string>("/opt/aura-venv");
  const [storageMounts, setStorageMounts] = useState<StorageMount[]>([]);
  const [dataNfsPath, setDataNfsPath] = useState<string>("");
  const [loaded, setLoaded] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"form" | "command">("form");
  const [newName, setNewName] = useState("");
  const [newIndexUrl, setNewIndexUrl] = useState("");
  const [newExtraIndexUrl, setNewExtraIndexUrl] = useState("");
  const [rawCommand, setRawCommand] = useState("");

  const [applying, setApplying] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [pkgStatuses, setPkgStatuses] = useState<Record<string, { installed: boolean; version?: string }>>({});
  const [perHostStatuses, setPerHostStatuses] = useState<Record<string, Record<string, { installed: boolean; version?: string }>>>({});
  const [targets, setTargets] = useState<string[]>([]);
  const [statusMode, setStatusMode] = useState<"shared" | "per-node">("shared");
  const [venvExists, setVenvExists] = useState<boolean | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [logDialog, setLogDialog] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logStatus, setLogStatus] = useState<"running" | "success" | "failed">("running");
  const logRef = useRef<HTMLDivElement>(null);

  const fetchData = async () => {
    const r = await fetch(`/api/clusters/${clusterId}/python-packages`);
    if (r.ok) {
      const d = await r.json();
      setPackages(d.packages ?? []);
      setVenvLocation(d.venvLocation ?? "");
      setPythonVersion(d.pythonVersion ?? "3.12");
      setInstallMode((d.installMode as "shared" | "per-node") ?? "shared");
      setLocalVenvPath(d.localVenvPath ?? "/opt/aura-venv");
      setStorageMounts(d.storageMounts ?? []);
      setDataNfsPath(d.dataNfsPath ?? "");

      // Re-attach to an in-progress apply if we left one running.
      if (d.latestTask && d.latestTask.status === "running") {
        attachToTask(d.latestTask.id);
      }
    }
    setLoaded(true);
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

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  const fetchStatuses = async () => {
    if (packages.length === 0) {
      setPkgStatuses({});
      setPerHostStatuses({});
      return;
    }
    if (installMode === "shared" && !venvLocation) return;
    setCheckingStatus(true);
    try {
      const r = await fetch(`/api/clusters/${clusterId}/python-packages/status`, { method: "POST" });
      if (r.ok) {
        const d = await r.json();
        setStatusMode(d.mode ?? installMode);
        if (d.mode === "per-node") {
          setPerHostStatuses(d.perHost ?? {});
          setTargets(d.targets ?? []);
          setPkgStatuses({});
          setVenvExists(null);
        } else {
          setPkgStatuses(d.statuses ?? {});
          setVenvExists(d.venvExists ?? false);
          setPerHostStatuses({});
          setTargets([]);
        }
      }
    } catch {}
    finally {
      setCheckingStatus(false);
    }
  };

  useEffect(() => {
    fetchStatuses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packages.length, venvLocation, installMode, clusterId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const persist = async (
    nextPackages: PythonPackage[],
    nextLocation: string,
    nextPythonVersion: string = pythonVersion,
    nextInstallMode: "shared" | "per-node" = installMode,
    nextLocalVenvPath: string = localVenvPath,
  ) => {
    const res = await fetch(`/api/clusters/${clusterId}/python-packages`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packages: nextPackages,
        venvLocation: nextLocation,
        pythonVersion: nextPythonVersion,
        installMode: nextInstallMode,
        localVenvPath: nextLocalVenvPath,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      toast.error(err.error ?? "Failed to save");
      return false;
    }
    return true;
  };

  const resetAddForm = () => {
    setNewName("");
    setNewIndexUrl("");
    setNewExtraIndexUrl("");
    setRawCommand("");
  };

  // Parse a `pip install ...` one-liner into (packages, indexUrl, extraIndexUrl).
  // Ignores flags that don't affect what gets installed (e.g. --upgrade, -q).
  // Returns null + reason if nothing usable is found.
  const parsePipCommand = (input: string): { pkgs: string[]; indexUrl?: string; extraIndexUrl?: string } | { error: string } => {
    let s = input.trim();
    if (!s) return { error: "Empty command" };
    // Strip leading "pip install" or "pip3 install" or "python -m pip install"
    s = s.replace(/^\s*(python3?\s+-m\s+)?pip3?\s+install\s+/i, "").trim();
    // Collapse line continuations
    s = s.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ").trim();

    const tokens: string[] = [];
    let buf = "";
    let quote: string | null = null;
    for (const ch of s) {
      if (quote) {
        if (ch === quote) { quote = null; continue; }
        buf += ch;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === " ") {
        if (buf) { tokens.push(buf); buf = ""; }
      } else {
        buf += ch;
      }
    }
    if (buf) tokens.push(buf);

    const pkgs: string[] = [];
    let indexUrl: string | undefined;
    let extraIndexUrl: string | undefined;

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t) continue;
      if (t === "--index-url" || t === "-i") { indexUrl = tokens[++i]; continue; }
      if (t.startsWith("--index-url=")) { indexUrl = t.slice("--index-url=".length); continue; }
      if (t === "--extra-index-url") { extraIndexUrl = tokens[++i]; continue; }
      if (t.startsWith("--extra-index-url=")) { extraIndexUrl = t.slice("--extra-index-url=".length); continue; }
      // Flags that take a value — skip the next token
      if (t === "-r" || t === "--requirement" || t === "-c" || t === "--constraint" || t === "--find-links" || t === "-f") {
        i++;
        continue;
      }
      // Unknown flags (no value): skip this token only
      if (t.startsWith("-")) continue;
      pkgs.push(t);
    }

    if (pkgs.length === 0) return { error: "No packages found in command" };
    return { pkgs, indexUrl, extraIndexUrl };
  };

  const handleAdd = async () => {
    let toAdd: PythonPackage[] = [];

    if (addMode === "form") {
      const name = newName.trim();
      if (!name) return;
      if (packages.some((p) => p.name === name)) {
        toast.error(`${name} is already in the list`);
        return;
      }
      const entry: PythonPackage = { name };
      const iu = newIndexUrl.trim();
      const eu = newExtraIndexUrl.trim();
      if (iu) entry.indexUrl = iu;
      if (eu) entry.extraIndexUrl = eu;
      toAdd = [entry];
    } else {
      const parsed = parsePipCommand(rawCommand);
      if ("error" in parsed) {
        toast.error(parsed.error);
        return;
      }
      const existing = new Set(packages.map((p) => p.name));
      toAdd = parsed.pkgs
        .filter((p) => !existing.has(p))
        .map((name) => {
          const entry: PythonPackage = { name };
          if (parsed.indexUrl) entry.indexUrl = parsed.indexUrl;
          if (parsed.extraIndexUrl) entry.extraIndexUrl = parsed.extraIndexUrl;
          return entry;
        });
      if (toAdd.length === 0) {
        toast.error("All parsed packages are already in the list");
        return;
      }
    }

    const updated = [...packages, ...toAdd];
    setPackages(updated);
    resetAddForm();
    setAddOpen(false);
    await persist(updated, venvLocation);
  };

  const handleRemove = async (name: string) => {
    const updated = packages.filter((p) => p.name !== name);
    setPackages(updated);
    await persist(updated, venvLocation);
  };

  const handleLocationChange = async (value: string) => {
    setVenvLocation(value);
    await persist(packages, value);
  };

  const locationOptions: Array<{ value: string; label: string; hint?: string }> = [];
  if (dataNfsPath) {
    locationOptions.push({ value: dataNfsPath, label: `${dataNfsPath} (NFS home)`, hint: "NFS" });
  }
  for (const m of storageMounts) {
    locationOptions.push({
      value: m.mountPath,
      label: `${m.mountPath} (${m.type})`,
      hint: m.type,
    });
  }

  const selectedMount = storageMounts.find((m) => m.mountPath === venvLocation);
  const isS3 = selectedMount?.type === "s3fs";

  const handleApply = async () => {
    // If a task is already running (still tracked in this session, or picked up
    // via fetchData from the server), just reopen the log dialog instead of
    // kicking off a duplicate install.
    if (applying && currentTaskId) {
      setLogDialog(true);
      return;
    }

    if (packages.length === 0) {
      toast.error("Add at least one package first");
      return;
    }
    if (installMode === "shared" && !venvLocation) {
      toast.error("Select a storage location for the venv");
      return;
    }

    const res = await fetch(`/api/clusters/${clusterId}/python-packages/apply`, { method: "POST" });
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

  const venvPath = installMode === "shared"
    ? (venvLocation ? `${venvLocation.replace(/\/+$/, "")}/aura-venv` : "")
    : localVenvPath.replace(/\/+$/, "");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          onClick={fetchStatuses}
          disabled={packages.length === 0 || (installMode === "shared" && !venvLocation) || checkingStatus}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${checkingStatus ? "animate-spin" : ""}`} />
          Refresh Status
        </Button>
        <Button
          variant="outline"
          onClick={handleApply}
          disabled={!applying && (packages.length === 0 || (installMode === "shared" && !venvLocation))}
        >
          {applying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          {applying ? "Show Progress" : "Apply to Cluster"}
        </Button>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Package
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Virtual Environment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Install Mode</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={installMode === "shared" ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setInstallMode("shared");
                  persist(packages, venvLocation, pythonVersion, "shared", localVenvPath);
                }}
              >
                Shared (one venv on storage)
              </Button>
              <Button
                type="button"
                variant={installMode === "per-node" ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setInstallMode("per-node");
                  persist(packages, venvLocation, pythonVersion, "per-node", localVenvPath);
                }}
              >
                Per-node (install on each node)
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {installMode === "shared"
                ? "Single venv on shared storage. Fast to set up; imports cross the network."
                : "Identical venv on each node's local disk. Faster imports, more disk used, extra install time."}
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-[1fr_160px]">
            {installMode === "shared" ? (
              <div className="space-y-2">
                <Label>Storage Location</Label>
                <Select
                  value={venvLocation}
                  onValueChange={(v) => { if (v !== null) handleLocationChange(v); }}
                  disabled={locationOptions.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={locationOptions.length === 0 ? "No shared storage available" : "Select a location"} />
                  </SelectTrigger>
                  <SelectContent>
                    {locationOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="local-venv">Local Venv Path (on each node)</Label>
                <Input
                  id="local-venv"
                  placeholder="/opt/aura-venv"
                  value={localVenvPath}
                  onChange={(e) => setLocalVenvPath(e.target.value)}
                  onBlur={() => persist(packages, venvLocation, pythonVersion, installMode, localVenvPath)}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="python-version">Python Version</Label>
              <Select
                value={pythonVersion}
                onValueChange={(v) => {
                  if (!v) return;
                  setPythonVersion(v);
                  persist(packages, venvLocation, v, installMode, localVenvPath);
                }}
              >
                <SelectTrigger id="python-version">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["3.10", "3.11", "3.12", "3.13"].map((v) => (
                    <SelectItem key={v} value={v}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {venvPath && (
            <p className="text-xs text-muted-foreground">
              Venv managed by <code>uv</code> at <code className="font-mono">{venvPath}</code>.
              Activate in jobs with <code className="font-mono">source {venvPath}/bin/activate</code>.
              Changing the Python version recreates the venv on next Apply.
            </p>
          )}
          {isS3 && installMode === "shared" && (
            <p className="text-xs text-yellow-600 dark:text-yellow-400">
              Warning: installing a venv onto s3fs is slow and can be fragile with many small files.
              Prefer NFS for the venv itself, or switch to Per-node mode.
            </p>
          )}

        </CardContent>
      </Card>

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
              No packages configured. Add pip packages to install into the shared venv.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Index URL</TableHead>
                  <TableHead className="w-[120px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {packages.map((pkg) => {
                  const st = pkgStatuses[pkg.name];

                  // Per-node mode: compute N/M installed count
                  let perNodeBadge: React.ReactNode = null;
                  if (statusMode === "per-node" && targets.length > 0) {
                    const total = targets.length;
                    const installedCount = targets.filter((h) => perHostStatuses[h]?.[pkg.name]?.installed).length;
                    if (installedCount === total) {
                      const sampleVer = perHostStatuses[targets[0]]?.[pkg.name]?.version;
                      perNodeBadge = (
                        <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                          Installed ({installedCount}/{total}){sampleVer ? ` — ${sampleVer}` : ""}
                        </Badge>
                      );
                    } else if (installedCount === 0) {
                      perNodeBadge = (
                        <Badge variant="outline" className="text-muted-foreground">
                          Not installed (0/{total})
                        </Badge>
                      );
                    } else {
                      perNodeBadge = (
                        <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                          Partial ({installedCount}/{total})
                        </Badge>
                      );
                    }
                  }

                  return (
                  <TableRow key={pkg.name}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-mono text-sm">
                        <Package className="h-3 w-3 text-muted-foreground" />
                        {pkg.name}
                      </div>
                    </TableCell>
                    <TableCell>
                      {statusMode === "per-node" ? (
                        perNodeBadge ?? <span className="text-xs text-muted-foreground">—</span>
                      ) : venvExists === false ? (
                        <span className="text-xs text-muted-foreground">No venv yet</span>
                      ) : !st ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : st.installed ? (
                        <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                          Installed{st.version ? ` (${st.version})` : ""}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          Not installed
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {pkg.indexUrl || pkg.extraIndexUrl ? (
                        <div className="font-mono text-xs text-muted-foreground space-y-0.5">
                          {pkg.indexUrl && <div><span className="text-foreground">index:</span> {pkg.indexUrl}</div>}
                          {pkg.extraIndexUrl && <div><span className="text-foreground">extra:</span> {pkg.extraIndexUrl}</div>}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">PyPI</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive"
                        title="Remove package"
                        onClick={() => handleRemove(pkg.name)}
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
      <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) resetAddForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Python Package</DialogTitle>
            <DialogDescription>
              Installed via <code>pip</code> into the shared venv when you click Apply to Cluster.
              Supports pinning (<code>numpy==1.26</code>) and extras (<code>torch[cuda]</code>).
            </DialogDescription>
          </DialogHeader>
          <Tabs value={addMode} onValueChange={(v) => setAddMode(v as "form" | "command")}>
            <TabsList>
              <TabsTrigger value="form">Form</TabsTrigger>
              <TabsTrigger value="command">Pip Command</TabsTrigger>
            </TabsList>

            <TabsContent value="form" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="pypkg-name">Package</Label>
                <Input
                  id="pypkg-name"
                  placeholder="e.g. torch==2.10.0, numpy==1.26, transformers>=4.40"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pypkg-index">Index URL (optional)</Label>
                <Input
                  id="pypkg-index"
                  placeholder="https://download.pytorch.org/whl/cu128"
                  value={newIndexUrl}
                  onChange={(e) => setNewIndexUrl(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Sent as <code>--index-url</code>. Replaces PyPI for this package.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pypkg-extra-index">Extra Index URL (optional)</Label>
                <Input
                  id="pypkg-extra-index"
                  placeholder="https://my.private-repo/simple"
                  value={newExtraIndexUrl}
                  onChange={(e) => setNewExtraIndexUrl(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Sent as <code>--extra-index-url</code>. Pip falls back to PyPI when a package isn't here.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="command" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="pypkg-cmd">Pip Command</Label>
                <Textarea
                  id="pypkg-cmd"
                  rows={5}
                  className="font-mono text-sm"
                  placeholder="pip install torch==2.10.0 torchvision==0.25.0 torchaudio==2.10.0 --index-url https://download.pytorch.org/whl/cu128"
                  value={rawCommand}
                  onChange={(e) => setRawCommand(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Paste a full <code>pip install</code> command — packages and <code>--index-url</code>/<code>--extra-index-url</code> are parsed out.
                  Flags like <code>-r</code>/<code>--requirement</code> are skipped.
                </p>
              </div>

              {(() => {
                const parsed = rawCommand.trim() ? parsePipCommand(rawCommand) : null;
                if (!parsed) return null;
                if ("error" in parsed) {
                  return <p className="text-xs text-destructive">{parsed.error}</p>;
                }
                return (
                  <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
                    <div className="font-medium text-foreground">Preview ({parsed.pkgs.length} package{parsed.pkgs.length === 1 ? "" : "s"})</div>
                    {parsed.indexUrl && <div><span className="text-muted-foreground">index:</span> <code>{parsed.indexUrl}</code></div>}
                    {parsed.extraIndexUrl && <div><span className="text-muted-foreground">extra:</span> <code>{parsed.extraIndexUrl}</code></div>}
                    <ul className="font-mono text-muted-foreground list-disc pl-5">
                      {parsed.pkgs.map((p) => <li key={p}>{p}</li>)}
                    </ul>
                  </div>
                );
              })()}
            </TabsContent>
          </Tabs>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={handleAdd}
              disabled={
                addMode === "form"
                  ? !newName.trim() || packages.some((p) => p.name === newName.trim())
                  : !rawCommand.trim()
              }
            >
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
              Installing Python Packages
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
