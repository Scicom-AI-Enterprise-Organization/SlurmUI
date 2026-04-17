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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Loader2, Pencil, Play } from "lucide-react";
import { toast } from "sonner";

interface Partition {
  name: string;
  default?: boolean;
  nodes: string;
  max_time?: string;
  state?: string;
}

interface PartitionsTabProps {
  clusterId: string;
}

function stateColor(state: string): string {
  const s = state.toLowerCase();
  if (s === "up") return "bg-green-100 text-green-800";
  if (s === "down" || s === "drain") return "bg-red-100 text-red-800";
  if (s === "inactive") return "bg-gray-100 text-gray-800";
  return "bg-gray-100 text-gray-800";
}

function expandNodes(spec: string): string[] {
  if (!spec) return [];
  if (spec === "ALL") return ["ALL"];
  return spec.split(",").map((s) => s.trim()).filter(Boolean);
}

export function PartitionsTab({ clusterId }: PartitionsTabProps) {
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [allNodes, setAllNodes] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [form, setForm] = useState<Partition>({ name: "", nodes: "", max_time: "INFINITE", state: "UP", default: false });

  const [applying, setApplying] = useState(false);
  const [logDialog, setLogDialog] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logStatus, setLogStatus] = useState<"running" | "success" | "failed">("running");
  const logRef = useRef<HTMLDivElement>(null);

  const fetchData = async () => {
    const r = await fetch(`/api/clusters/${clusterId}/partitions`);
    if (r.ok) {
      const d = await r.json();
      setPartitions(d.partitions ?? []);
      setAllNodes(d.nodes ?? []);
    }
    setLoaded(true);
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const openAdd = () => {
    setEditIndex(null);
    setForm({ name: "", nodes: "", max_time: "INFINITE", state: "UP", default: partitions.length === 0 });
    setEditOpen(true);
  };

  const openEdit = (idx: number) => {
    setEditIndex(idx);
    setForm({ ...partitions[idx] });
    setEditOpen(true);
  };

  const toggleNode = (node: string) => {
    if (form.nodes === "ALL") {
      // expand ALL to concrete list first, then toggle
      const concrete = new Set(allNodes);
      concrete.delete(node);
      setForm({ ...form, nodes: Array.from(concrete).join(",") });
      return;
    }
    const cur = new Set(expandNodes(form.nodes));
    if (cur.has(node)) cur.delete(node);
    else cur.add(node);
    setForm({ ...form, nodes: Array.from(cur).join(",") });
  };

  const persist = async (next: Partition[]) => {
    const res = await fetch(`/api/clusters/${clusterId}/partitions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partitions: next }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      toast.error(err.error ?? "Failed to save");
      return false;
    }
    setPartitions(next);
    return true;
  };

  const saveForm = async () => {
    const name = form.name.trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      toast.error("Invalid partition name (letters, digits, _ or - only)");
      return;
    }
    if (!form.nodes || form.nodes.length === 0) {
      toast.error("Select at least one node");
      return;
    }
    const nextPartitions = [...partitions];
    const updated: Partition = {
      name,
      nodes: form.nodes,
      max_time: form.max_time || "INFINITE",
      state: form.state || "UP",
      default: !!form.default,
    };
    if (updated.default) {
      nextPartitions.forEach((p) => { p.default = false; });
    }
    if (editIndex === null) {
      if (nextPartitions.some((p) => p.name === name)) {
        toast.error(`Partition "${name}" already exists`);
        return;
      }
      nextPartitions.push(updated);
    } else {
      nextPartitions[editIndex] = updated;
    }
    if (await persist(nextPartitions)) setEditOpen(false);
  };

  const removePartition = async (idx: number) => {
    const next = partitions.filter((_, i) => i !== idx);
    if (next.length > 0 && !next.some((p) => p.default)) next[0].default = true;
    await persist(next);
  };

  const applyPartitions = async () => {
    setApplying(true);
    setLogLines([]);
    setLogStatus("running");
    setLogDialog(true);

    const res = await fetch(`/api/clusters/${clusterId}/partitions/apply`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setLogLines([`[error] ${err.error ?? "Failed to start"}`]);
      setLogStatus("failed");
      setApplying(false);
      return;
    }
    const { taskId } = await res.json();
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
          fetchData();
        } else if (t.status === "failed") {
          setLogStatus("failed");
          clearInterval(poll);
          setApplying(false);
        }
      } catch {}
    }, 2000);
  };

  const selectedNodes = expandNodes(form.nodes);
  const allSelected = form.nodes === "ALL" || (allNodes.length > 0 && allNodes.every((n) => selectedNodes.includes(n)));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          onClick={applyPartitions}
          disabled={partitions.length === 0 || applying}
          title="Rewrite PartitionName lines in slurm.conf and restart slurmctld"
        >
          {applying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          Apply to Cluster
        </Button>
        <Button onClick={openAdd}>
          <Plus className="mr-2 h-4 w-4" />
          Add Partition
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Partitions ({partitions.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!loaded ? (
            <p className="text-center text-muted-foreground py-6">Loading...</p>
          ) : partitions.length === 0 ? (
            <p className="text-center text-muted-foreground py-6">
              No partitions configured. Add one to route jobs to specific nodes.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Nodes</TableHead>
                  <TableHead>Max Time</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="w-[120px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {partitions.map((p, idx) => (
                  <TableRow key={p.name}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-mono text-sm">
                        {p.name}
                        {p.default && (
                          <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                            Default
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {p.nodes === "ALL" ? (
                        <Badge variant="outline">ALL</Badge>
                      ) : (
                        <span className="text-muted-foreground">{p.nodes}</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{p.max_time ?? "INFINITE"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={stateColor(p.state ?? "UP")}>
                        {p.state ?? "UP"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Edit partition"
                        onClick={() => openEdit(idx)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive"
                        title="Remove partition"
                        onClick={() => removePartition(idx)}
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

      {/* Add/Edit Partition Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editIndex === null ? "Add Partition" : `Edit ${partitions[editIndex]?.name}`}</DialogTitle>
            <DialogDescription>
              Changes are saved to cluster config. Click <strong>Apply to Cluster</strong> to
              rewrite <code>slurm.conf</code> and restart <code>slurmctld</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="part-name">Name</Label>
              <Input
                id="part-name"
                placeholder="e.g. gpu, cpu, debug"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                disabled={editIndex !== null}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="part-maxtime">Max Time</Label>
                <Input
                  id="part-maxtime"
                  placeholder="INFINITE, 1-00:00:00, 4:00:00"
                  value={form.max_time ?? ""}
                  onChange={(e) => setForm({ ...form, max_time: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="part-state">State</Label>
                <Select value={form.state ?? "UP"} onValueChange={(v) => setForm({ ...form, state: v ?? "UP" })}>
                  <SelectTrigger id="part-state">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UP">UP</SelectItem>
                    <SelectItem value="DOWN">DOWN</SelectItem>
                    <SelectItem value="DRAIN">DRAIN</SelectItem>
                    <SelectItem value="INACTIVE">INACTIVE</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="part-default"
                checked={!!form.default}
                onCheckedChange={(c) => setForm({ ...form, default: !!c })}
              />
              <Label htmlFor="part-default" className="font-normal">
                Default partition (jobs without <code>-p</code> go here)
              </Label>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Nodes</Label>
                {allNodes.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setForm({ ...form, nodes: allSelected ? "" : allNodes.join(",") })}
                  >
                    {allSelected ? "Deselect all" : "Select all"}
                  </Button>
                )}
              </div>
              {allNodes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No nodes available. Add nodes first.</p>
              ) : (
                <div className="rounded-md border max-h-56 overflow-y-auto">
                  {allNodes.map((n) => {
                    const checked = form.nodes === "ALL" || selectedNodes.includes(n);
                    return (
                      <label
                        key={n}
                        className="flex items-center gap-2 px-3 py-2 border-b last:border-0 cursor-pointer hover:bg-muted/50"
                      >
                        <Checkbox checked={checked} onCheckedChange={() => toggleNode(n)} />
                        <span className="font-mono text-sm">{n}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={saveForm}>{editIndex === null ? "Add" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Log Dialog */}
      <Dialog open={logDialog} onOpenChange={logStatus !== "running" ? setLogDialog : undefined}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-8">
              Applying Partitions
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
