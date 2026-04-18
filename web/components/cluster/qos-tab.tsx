"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Plus, RefreshCw, Trash2, Pencil } from "lucide-react";

interface QosRow {
  name: string;
  priority: string;
  maxJobsPU: string;
  maxSubmitPU: string;
  maxWall: string;
  maxTRESPU: string;
  maxTRESPJ: string;
  grpTRES: string;
  grpJobs: string;
  flags: string;
}

type FieldKey = "Priority" | "MaxJobsPU" | "MaxSubmitPU" | "MaxWall" | "MaxTRESPU" | "MaxTRESPJ" | "GrpTRES" | "GrpJobs" | "Flags";

const FIELD_LABELS: Array<{ key: FieldKey; label: string; placeholder: string; help?: string }> = [
  { key: "Priority", label: "Priority", placeholder: "100", help: "Higher = scheduled earlier." },
  { key: "MaxJobsPU", label: "Max jobs per user", placeholder: "10" },
  { key: "MaxSubmitPU", label: "Max submissions per user", placeholder: "100" },
  { key: "MaxWall", label: "Max wall time", placeholder: "1-00:00:00" },
  { key: "MaxTRESPU", label: "Max TRES per user", placeholder: "cpu=64,gres/gpu=4" },
  { key: "MaxTRESPJ", label: "Max TRES per job", placeholder: "cpu=32,gres/gpu=8" },
  { key: "GrpTRES", label: "Group TRES cap", placeholder: "cpu=256,gres/gpu=16" },
  { key: "GrpJobs", label: "Group max concurrent jobs", placeholder: "20" },
  { key: "Flags", label: "Flags", placeholder: "DenyOnLimit,NoReserve" },
];

const EMPTY_FIELDS: Record<FieldKey, string> = {
  Priority: "", MaxJobsPU: "", MaxSubmitPU: "", MaxWall: "",
  MaxTRESPU: "", MaxTRESPJ: "", GrpTRES: "", GrpJobs: "", Flags: "",
};

export function QosTab({ clusterId }: { clusterId: string }) {
  const [rows, setRows] = useState<QosRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [editing, setEditing] = useState<QosRow | null>(null); // null = create, row = modify
  const [name, setName] = useState("");
  const [fields, setFields] = useState<Record<FieldKey, string>>({ ...EMPTY_FIELDS });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<QosRow | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [resultDialog, setResultDialog] = useState<{ ok: boolean; title: string; body: string } | null>(null);

  const load = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/qos`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setRows(d.qos ?? []);
      setErrMsg(null);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setRefreshing(false);
      setLoaded(true);
    }
  };

  useEffect(() => { load(); }, [clusterId]);

  const openCreate = () => {
    setEditing(null);
    setName("");
    setFields({ ...EMPTY_FIELDS });
    setDialogOpen(true);
  };

  const openEdit = (r: QosRow) => {
    setEditing(r);
    setName(r.name);
    setFields({
      Priority: r.priority || "",
      MaxJobsPU: r.maxJobsPU || "",
      MaxSubmitPU: r.maxSubmitPU || "",
      MaxWall: r.maxWall || "",
      MaxTRESPU: r.maxTRESPU || "",
      MaxTRESPJ: r.maxTRESPJ || "",
      GrpTRES: r.grpTRES || "",
      GrpJobs: r.grpJobs || "",
      Flags: r.flags || "",
    });
    setDialogOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      // Only send non-empty fields; let sacctmgr keep existing values on empty.
      const payload: Record<string, string> = { name };
      for (const [k, v] of Object.entries(fields)) {
        if (v.trim() !== "") payload[k] = v.trim();
      }
      const url = editing
        ? `/api/clusters/${clusterId}/qos/${editing.name}`
        : `/api/clusters/${clusterId}/qos`;
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) {
        setResultDialog({ ok: false, title: editing ? `Update failed` : "Create failed", body: d.error ?? `HTTP ${res.status}` });
        return;
      }
      setDialogOpen(false);
      setResultDialog({ ok: true, title: editing ? `Updated ${editing.name}` : `Created ${name}`, body: d.output || "OK" });
      load();
    } catch (e) {
      setResultDialog({ ok: false, title: "Save failed", body: e instanceof Error ? e.message : "Network error" });
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async (row: QosRow) => {
    setDeleting(row.name);
    setConfirmDelete(null);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/qos/${row.name}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) {
        setResultDialog({ ok: false, title: `Delete ${row.name} failed`, body: d.error ?? `HTTP ${res.status}` });
      } else {
        setResultDialog({ ok: true, title: `Deleted ${row.name}`, body: d.output || "OK" });
        load();
      }
    } catch (e) {
      setResultDialog({ ok: false, title: `Delete ${row.name} failed`, body: e instanceof Error ? e.message : "Network error" });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={load} disabled={refreshing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </Button>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> New QoS
        </Button>
      </div>

      {errMsg && <p className="text-sm text-destructive">{errMsg}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">QoS ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {!loaded ? (
            <p className="text-center text-muted-foreground py-6">Loading...</p>
          ) : rows.length === 0 ? (
            <p className="text-center text-muted-foreground py-6">
              No QoS entries. Requires Slurm accounting (<code>slurmdbd</code>) to be enabled.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>MaxJobsPU</TableHead>
                  <TableHead>MaxWall</TableHead>
                  <TableHead>MaxTRESPU</TableHead>
                  <TableHead>GrpTRES</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.name}>
                    <TableCell className="font-mono text-sm">{r.name}</TableCell>
                    <TableCell className="font-mono text-xs">{r.priority || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.maxJobsPU || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.maxWall || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.maxTRESPU || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.grpTRES || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.flags || "—"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon-sm" title="Edit" onClick={() => openEdit(r)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost" size="icon-sm"
                          title={r.name.toLowerCase() === "normal" ? "Cannot delete 'normal'" : "Delete"}
                          disabled={r.name.toLowerCase() === "normal" || deleting === r.name}
                          onClick={() => setConfirmDelete(r)}
                        >
                          {deleting === r.name
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Trash2 className="h-4 w-4 text-destructive" />}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit QoS ${editing.name}` : "New QoS"}</DialogTitle>
            <DialogDescription>
              Wraps <code>sacctmgr {editing ? "modify" : "add"} qos</code>. Empty fields are left unchanged
              when editing. Use <code>-1</code> to remove a limit explicitly.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {!editing && (
              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">Name (A-Z, 0-9, _, -)</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="research-high" />
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              {FIELD_LABELS.map((f) => (
                <div key={f.key} className="space-y-1">
                  <Label className="text-xs font-medium text-muted-foreground">{f.label}</Label>
                  <Input
                    value={fields[f.key]}
                    onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
                    placeholder={f.placeholder}
                  />
                  {f.help && <p className="text-[10px] text-muted-foreground">{f.help}</p>}
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={save} disabled={saving || (!editing && !name)}>
              {saving
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{editing ? "Saving..." : "Creating..."}</>
                : (editing ? "Save changes" : "Create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete QoS {confirmDelete?.name}?</DialogTitle>
            <DialogDescription>
              Runs <code>sacctmgr delete qos where name={confirmDelete?.name}</code>. Fails if any user
              or account still has this QoS assigned — unassign first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button variant="destructive" onClick={() => confirmDelete && doDelete(confirmDelete)}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!resultDialog} onOpenChange={(o) => { if (!o) setResultDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className={resultDialog?.ok ? "" : "text-destructive"}>{resultDialog?.title}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {resultDialog?.body}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResultDialog(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
