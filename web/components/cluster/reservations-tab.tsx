"use client";

import { useEffect, useState } from "react";
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
import { Loader2, Plus, RefreshCw, Trash2, ChevronDown, Check, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import {
  Select as SingleSelect,
  SelectContent as SingleSelectContent,
  SelectItem as SingleSelectItem,
  SelectTrigger as SingleSelectTrigger,
  SelectValue as SingleSelectValue,
} from "@/components/ui/select";

interface Reservation {
  name: string;
  startTime: string;
  endTime: string;
  duration: string;
  nodes: string;
  nodeCount: string;
  users: string;
  accounts: string;
  partition: string;
  flags: string;
  state: string;
  tres: string;
}

interface ClusterUserOpt { id: string; label: string; unix: string }

export function ReservationsTab({ clusterId }: { clusterId: string }) {
  const [rows, setRows] = useState<Reservation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [availableNodes, setAvailableNodes] = useState<string[]>([]);
  const [availableUsers, setAvailableUsers] = useState<ClusterUserOpt[]>([]);
  const [availablePartitions, setAvailablePartitions] = useState<string[]>([]);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<{
    name: string;
    startTime: string;
    duration: string;
    endTime: string;
    selectedNodes: string[];
    nodeCount: string;
    selectedUsers: string[];
    accounts: string;
    partition: string;
    flags: string;
  }>({
    name: "",
    startTime: "",
    duration: "1:00:00",
    endTime: "",
    selectedNodes: [],
    nodeCount: "",
    selectedUsers: [],
    accounts: "",
    partition: "",
    flags: "",
  });
  const [saving, setSaving] = useState(false);
  const [resultDialog, setResultDialog] = useState<{ ok: boolean; title: string; body: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Reservation | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/reservations`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setRows(d.reservations ?? []);
      setErrMsg(null);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setRefreshing(false);
      setLoaded(true);
    }
  };

  useEffect(() => { load(); }, [clusterId]);

  useEffect(() => {
    fetch(`/api/clusters/${clusterId}/resources`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setAvailableNodes((d.nodes ?? []).map((n: { host: string }) => n.host)))
      .catch(() => {});
    fetch(`/api/clusters/${clusterId}/users`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: Array<{ user: { id: string; email: string; name: string | null; unixUsername: string | null } }>) => {
        const opts = d
          .filter((c) => c.user.unixUsername)
          .map((c) => ({
            id: c.user.id,
            label: c.user.name ?? c.user.email,
            unix: c.user.unixUsername as string,
          }));
        setAvailableUsers(opts);
      })
      .catch(() => {});
    fetch(`/api/clusters/${clusterId}`)
      .then((r) => r.json())
      .then((c) => {
        const parts = ((c.config?.slurm_partitions ?? []) as Array<{ name: string }>).map((p) => p.name);
        setAvailablePartitions(parts);
      })
      .catch(() => {});
  }, [clusterId]);

  // Build the preview of the command that will run on the controller.
  const buildScontrolCmd = () => {
    const parts: string[] = [`ReservationName=${form.name || "<name>"}`];
    parts.push(`StartTime=${form.startTime || "<required>"}`);
    if (form.duration) parts.push(`Duration=${form.duration}`);
    if (form.endTime) parts.push(`EndTime=${form.endTime}`);
    if (form.selectedNodes.length > 0) parts.push(`Nodes=${form.selectedNodes.join(",")}`);
    if (form.nodeCount) parts.push(`NodeCnt=${form.nodeCount}`);
    if (form.selectedUsers.length > 0) parts.push(`Users=${form.selectedUsers.join(",")}`);
    if (form.accounts) parts.push(`Accounts=${form.accounts}`);
    if (form.partition) parts.push(`PartitionName=${form.partition}`);
    if (form.flags) parts.push(`Flags=${form.flags}`);
    return `sudo scontrol create reservation ${parts.join(" ")}`;
  };

  const handleCreate = async () => {
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        startTime: form.startTime,
        duration: form.duration,
        endTime: form.endTime,
        nodes: form.selectedNodes.join(","),
        nodeCount: form.nodeCount,
        users: form.selectedUsers.join(","),
        accounts: form.accounts,
        partition: form.partition,
        flags: form.flags,
      };
      const res = await fetch(`/api/clusters/${clusterId}/reservations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) {
        setResultDialog({ ok: false, title: "Create failed", body: d.error ?? `HTTP ${res.status}` });
        return;
      }
      setAddOpen(false);
      setResultDialog({ ok: true, title: `Created ${form.name}`, body: d.output || "OK" });
      setForm({ name: "", startTime: "", duration: "1:00:00", endTime: "", selectedNodes: [], nodeCount: "", selectedUsers: [], accounts: "", partition: "", flags: "" });
      load();
    } catch (e) {
      setResultDialog({ ok: false, title: "Create failed", body: e instanceof Error ? e.message : "Network error" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    setDeleting(name);
    setConfirmDelete(null);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/reservations/${name}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) {
        setResultDialog({ ok: false, title: `Delete ${name} failed`, body: d.error ?? `HTTP ${res.status}` });
      } else {
        setResultDialog({ ok: true, title: `Deleted ${name}`, body: d.output || "OK" });
        load();
      }
    } catch (e) {
      setResultDialog({ ok: false, title: `Delete ${name} failed`, body: e instanceof Error ? e.message : "Network error" });
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
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New reservation
        </Button>
      </div>

      {errMsg && <p className="text-sm text-destructive">{errMsg}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reservations ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {!loaded ? (
            <p className="text-center text-muted-foreground py-6">Loading...</p>
          ) : rows.length === 0 ? (
            <p className="text-center text-muted-foreground py-6">
              No reservations. Create one to hold nodes for maintenance or a specific user/account window.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Nodes</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead className="w-[120px]">State</TableHead>
                  <TableHead className="w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.name}>
                    <TableCell className="font-mono text-sm">{r.name}</TableCell>
                    <TableCell className="text-xs">
                      <div>{r.startTime}</div>
                      <div className="text-muted-foreground">→ {r.endTime} ({r.duration})</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.nodes || "—"}
                      {r.nodeCount && <span className="text-muted-foreground ml-1">({r.nodeCount})</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.users && <div>users: {r.users}</div>}
                      {r.accounts && <div>accounts: {r.accounts}</div>}
                      {r.partition && <div>partition: {r.partition}</div>}
                      {r.flags && <div className="text-muted-foreground">flags: {r.flags}</div>}
                    </TableCell>
                    <TableCell><Badge variant="outline" className="font-mono text-xs">{r.state}</Badge></TableCell>
                    <TableCell>
                      <Button
                        variant="ghost" size="icon-sm"
                        title="Delete reservation"
                        onClick={() => setConfirmDelete(r)}
                        disabled={deleting === r.name}
                      >
                        {deleting === r.name
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Trash2 className="h-4 w-4 text-destructive" />}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New reservation</DialogTitle>
            <DialogDescription>
              Wraps <code>scontrol create reservation</code>. Provide either duration or end time,
              and either an explicit node list or a node count. Users/accounts field restricts who
              can submit into the reservation.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Name (A-Z, 0-9, _, -)">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="maint-2026-05-01" />
            </Field>
            <Field label="Partition (optional)">
              <SingleSelect value={form.partition || "__any__"}
                onValueChange={(v) => setForm({ ...form, partition: v === "__any__" ? "" : v })}>
                <SingleSelectTrigger>
                  <SingleSelectValue placeholder="Any partition" />
                </SingleSelectTrigger>
                <SingleSelectContent>
                  <SingleSelectItem value="__any__">Any partition</SingleSelectItem>
                  {availablePartitions.map((p) => (
                    <SingleSelectItem key={p} value={p}>{p}</SingleSelectItem>
                  ))}
                </SingleSelectContent>
              </SingleSelect>
            </Field>
            <Field label="Start">
              <Input type="datetime-local" value={form.startTime}
                onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
            </Field>
            <Field label="End (optional — use duration instead)">
              <Input type="datetime-local" value={form.endTime}
                onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
            </Field>
            <Field label="Duration (DD-HH:MM:SS)">
              <Input value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} placeholder="1:00:00" />
            </Field>
            <Field label="Node count (alternative to node list)">
              <Input value={form.nodeCount} onChange={(e) => setForm({ ...form, nodeCount: e.target.value })} placeholder="2" />
            </Field>
            <Field label="Nodes">
              <MultiSelect
                values={form.selectedNodes}
                options={availableNodes}
                onChange={(v) => setForm({ ...form, selectedNodes: v })}
                placeholder="All nodes"
                emptyMsg="No nodes returned."
              />
            </Field>
            <Field label="Users">
              <MultiSelect
                values={form.selectedUsers}
                options={availableUsers.map((u) => u.unix)}
                onChange={(v) => setForm({ ...form, selectedUsers: v })}
                labels={Object.fromEntries(availableUsers.map((u) => [u.unix, `${u.label} (${u.unix})`]))}
                placeholder="No user restriction"
                emptyMsg="No provisioned users."
              />
            </Field>
            <Field label="Accounts">
              <Input value={form.accounts} onChange={(e) => setForm({ ...form, accounts: e.target.value })} placeholder="research" />
            </Field>
            <Field label="Flags (optional)">
              <Input value={form.flags} onChange={(e) => setForm({ ...form, flags: e.target.value })} placeholder="MAINT,IGNORE_JOBS" />
            </Field>
          </div>
          <div className="space-y-1 mt-2">
            <Label className="text-xs font-medium text-muted-foreground">Command preview</Label>
            <Textarea
              readOnly
              value={buildScontrolCmd()}
              className="font-mono text-xs bg-muted cursor-text"
              rows={3}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleCreate} disabled={saving || !form.name}>
              {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating...</> : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete reservation {confirmDelete?.name}?</DialogTitle>
            <DialogDescription>
              Runs <code>scontrol delete reservation={confirmDelete?.name}</code>. Nodes held by this
              reservation immediately become available to the general queue again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button variant="destructive" onClick={() => confirmDelete && handleDelete(confirmDelete.name)}>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function MultiSelect({
  values, options, onChange, placeholder, emptyMsg, labels,
}: {
  values: string[];
  options: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  emptyMsg: string;
  labels?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border bg-background px-3 py-1.5 min-h-9 text-sm shadow-xs hover:bg-accent"
      >
        <span className="flex flex-wrap items-center gap-1 text-left min-w-0">
          {values.length === 0 ? (
            <span className="text-muted-foreground">{placeholder}</span>
          ) : (
            values.map((v) => (
              <span
                key={v}
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(values.filter((x) => x !== v));
                }}
                className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-mono hover:bg-destructive/20"
              >
                {labels?.[v] ?? v}<X className="h-3 w-3" />
              </span>
            ))
          )}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-auto rounded-md border bg-popover p-1 shadow-md">
            {options.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{emptyMsg}</div>
            ) : (
              options.map((o) => {
                const checked = values.includes(o);
                return (
                  <button
                    type="button"
                    key={o}
                    onClick={() =>
                      onChange(checked ? values.filter((x) => x !== o) : [...values, o])
                    }
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <span className="flex h-4 w-4 items-center justify-center rounded border">
                      {checked && <Check className="h-3 w-3" />}
                    </span>
                    <span className="font-mono">{labels?.[o] ?? o}</span>
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
