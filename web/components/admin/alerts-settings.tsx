"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Bell, Plus, Pencil, Trash2, Loader2, Send, AlertTriangle, CheckCircle2,
} from "lucide-react";

type ChannelType = "slack" | "teams" | "generic";

interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  url: string;
  events: string[];
  clusters: string[];
  enabled: boolean;
  createdAt: string;
}

interface ClusterOption { id: string; name: string }

const SUGGESTED_EVENTS = [
  "cluster.*",
  "cluster.bootstrap",
  "cluster.teardown",
  "cluster.accounting",
  "node.add",
  "node.fix",
  "node.delete",
  "storage.deploy",
  "storage.remove",
  "packages.install",
  "python_packages.apply",
  "partitions.apply",
  "user.provision",
  "user.deprovision",
  "job.*",
  "job.submit",
  "job.submit_failed",
  "job.completed",
  "job.failed",
  "job.cancelled",
  "cluster.unreachable",
  "cluster.recovered",
  "node.unhealthy",
  "node.recovered",
  "storage.disconnected",
  "storage.reconnected",
  "job.stuck",
  "job.held",
];

export function AlertsSettings() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clusters, setClusters] = useState<ClusterOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [form, setForm] = useState<Channel>({
    id: "",
    name: "",
    type: "slack",
    url: "",
    events: [],
    clusters: [],
    enabled: true,
    createdAt: "",
  });

  const [confirmDelete, setConfirmDelete] = useState<Channel | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; status: number; body: string; name: string } | null>(null);

  // Dialog-local "test passed?" gate. Users must fire a successful test
  // webhook before Create is enabled; editing an existing channel doesn't
  // require re-testing unless url/type changes.
  const [formTestState, setFormTestState] = useState<"untested" | "testing" | "ok" | "failed">("untested");
  const [formTestMessage, setFormTestMessage] = useState("");

  const fetchChannels = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/settings/alerts");
      if (r.ok) setChannels(await r.json());
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => {
    fetchChannels();
    // Populate the cluster picker. Uses the admin cluster list endpoint.
    fetch("/api/clusters")
      .then((r) => r.ok ? r.json() : [])
      .then((d) => {
        const list = Array.isArray(d) ? d : (d?.clusters ?? []);
        setClusters(list.map((c: any) => ({ id: c.id, name: c.name })));
      })
      .catch(() => {});
  }, []);

  const persist = async (next: Channel[]) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/alerts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels: next }),
      });
      if (res.ok) setChannels(await res.json());
    } finally { setSaving(false); }
  };

  const openAdd = () => {
    setEditing(null);
    setForm({
      id: "",
      name: "",
      type: "slack",
      url: "",
      events: [],
      clusters: [],
      enabled: true,
      createdAt: "",
    });
    setFormTestState("untested");
    setFormTestMessage("");
    setEditOpen(true);
  };

  const openEdit = (c: Channel) => {
    setEditing(c);
    setForm({ ...c });
    // Existing channels skip the pre-save test gate — the row-level Test
    // button in the table handles on-demand verification.
    setFormTestState("ok");
    setFormTestMessage("");
    setEditOpen(true);
  };

  const runFormTest = async () => {
    if (!form.url.trim() || !/^https?:\/\//.test(form.url.trim())) {
      setFormTestState("failed");
      setFormTestMessage("Enter a valid http(s) URL first");
      return;
    }
    setFormTestState("testing");
    setFormTestMessage("");
    try {
      const res = await fetch("/api/settings/alerts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, name: form.name || "new-channel" }),
      });
      const body = await res.json();
      if (body.ok) {
        setFormTestState("ok");
        setFormTestMessage("Sent! Check the channel for the test message.");
      } else {
        setFormTestState("failed");
        setFormTestMessage(`HTTP ${body.status} — ${(body.body ?? "").slice(0, 200)}`);
      }
    } catch (err) {
      setFormTestState("failed");
      setFormTestMessage(err instanceof Error ? err.message : "Request failed");
    }
  };

  const saveForm = async () => {
    if (!form.name.trim() || !form.url.trim()) return;
    const next = editing
      ? channels.map((c) => (c.id === editing.id ? { ...form, id: editing.id } : c))
      : [...channels, { ...form, id: "", createdAt: new Date().toISOString() }];
    await persist(next);
    setEditOpen(false);
  };

  const removeChannel = async () => {
    if (!confirmDelete) return;
    const next = channels.filter((c) => c.id !== confirmDelete.id);
    await persist(next);
    setConfirmDelete(null);
  };

  const testChannel = async (c: Channel) => {
    setTesting(c.id);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/alerts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(c),
      });
      const body = await res.json();
      setTestResult({ ...body, name: c.name });
    } catch (err) {
      setTestResult({ ok: false, status: 0, body: err instanceof Error ? err.message : "failed", name: c.name });
    } finally {
      setTesting(null);
    }
  };

  const toggleEvent = (ev: string) => {
    setForm((f) => {
      const has = f.events.includes(ev);
      return { ...f, events: has ? f.events.filter((e) => e !== ev) : [...f.events, ev] };
    });
  };

  const toggleCluster = (id: string) => {
    setForm((f) => {
      const has = f.clusters.includes(id);
      return { ...f, clusters: has ? f.clusters.filter((x) => x !== id) : [...f.clusters, id] };
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="h-4 w-4" />
          Alerts
          <Badge variant="outline" className="font-normal">
            {channels.length} channel{channels.length === 1 ? "" : "s"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Route audit-log events to Slack, Teams, or any webhook. Each channel is
          filtered by a list of events (supports <code>cluster.*</code> wildcards).
          Empty event list = receive everything.
        </p>

        <div className="flex justify-end">
          <Button onClick={openAdd}>
            <Plus className="mr-2 h-4 w-4" /> Add channel
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : channels.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No alert channels yet.
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Clusters</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[180px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((c) => {
                  const scopeLabel = (c.clusters ?? []).length === 0
                    ? "(all)"
                    : (c.clusters ?? [])
                      .map((id) => clusters.find((x) => x.id === id)?.name ?? id.slice(0, 8))
                      .join(", ");
                  return (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{c.type}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {c.events.length === 0 ? "(all)" : c.events.join(", ")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {scopeLabel}
                    </TableCell>
                    <TableCell>
                      {c.enabled
                        ? <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Enabled</Badge>
                        : <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" title="Test" onClick={() => testChannel(c)} disabled={testing === c.id}>
                        {testing === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="Edit" onClick={() => openEdit(c)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="Delete" className="text-destructive" onClick={() => setConfirmDelete(c)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Add / edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit "${editing.name}"` : "Add alert channel"}</DialogTitle>
            <DialogDescription>
              Webhook payload is <code>{"{ text: ... }"}</code> which works for Slack incoming
              webhooks, Teams incoming webhooks, and most generic receivers.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-[1fr_160px]">
              <div className="space-y-2">
                <Label htmlFor="ch-name">Name</Label>
                <Input
                  id="ch-name"
                  placeholder="ops-slack"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ch-type">Type</Label>
                <Select
                  value={form.type}
                  onValueChange={(v) => {
                    if (!v) return;
                    setForm({ ...form, type: v as ChannelType });
                    setFormTestState("untested");
                    setFormTestMessage("");
                  }}
                >
                  <SelectTrigger id="ch-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="slack">Slack</SelectItem>
                    <SelectItem value="teams">Microsoft Teams</SelectItem>
                    <SelectItem value="generic">Generic webhook</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ch-url">Webhook URL</Label>
              <Input
                id="ch-url"
                placeholder={
                  form.type === "slack"
                    ? "https://hooks.slack.com/services/T.../B.../..."
                    : form.type === "teams"
                    ? "https://outlook.office.com/webhook/..."
                    : "https://example.com/hook"
                }
                value={form.url}
                onChange={(e) => {
                  setForm({ ...form, url: e.target.value });
                  // URL changed → gate resets to untested.
                  setFormTestState("untested");
                  setFormTestMessage("");
                }}
              />
              <p className="text-xs text-muted-foreground">
                Slack: <strong>Apps → Incoming Webhooks</strong>. Teams: <strong>Channel → Connectors → Incoming Webhook</strong>.
              </p>

              <div className="flex items-center gap-3 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={runFormTest}
                  disabled={formTestState === "testing" || !form.url.trim()}
                >
                  {formTestState === "testing" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                  {formTestState === "testing" ? "Testing..." : "Test webhook"}
                </Button>
                {formTestState === "ok" && (
                  <span className="text-xs text-green-700 dark:text-green-400 flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {formTestMessage || "Webhook accepted the test"}
                  </span>
                )}
                {formTestState === "failed" && (
                  <span className="text-xs text-destructive flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {formTestMessage}
                  </span>
                )}
                {formTestState === "untested" && (
                  <span className="text-xs text-muted-foreground">
                    {editing ? "Re-test recommended after changing URL/type." : "Send a test before creating."}
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Events</Label>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED_EVENTS.map((ev) => {
                  const on = form.events.includes(ev);
                  return (
                    <button
                      key={ev}
                      type="button"
                      onClick={() => toggleEvent(ev)}
                      className={
                        on
                          ? "rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs font-mono"
                          : "rounded-full border px-2.5 py-1 text-xs font-mono text-muted-foreground hover:bg-muted"
                      }
                    >
                      {ev}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                No event selected = receive <strong>all</strong> audit events. <code>cluster.*</code> matches every cluster action.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Clusters</Label>
              {clusters.length === 0 ? (
                <p className="text-xs text-muted-foreground">No clusters registered yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {clusters.map((c) => {
                    const on = form.clusters.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleCluster(c.id)}
                        className={
                          on
                            ? "rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs"
                            : "rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                        }
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                No cluster selected = receive events from <strong>all</strong> clusters. Pick one or more to scope this channel.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="ch-enabled"
                checked={form.enabled}
                onCheckedChange={(c) => setForm({ ...form, enabled: !!c })}
              />
              <Label htmlFor="ch-enabled" className="font-normal">Enabled</Label>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={saveForm}
              disabled={
                saving || !form.name.trim() || !form.url.trim() ||
                (!editing && formTestState !== "ok")
              }
              title={!editing && formTestState !== "ok" ? "Run a successful test first" : undefined}
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm delete */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete alert channel?</DialogTitle>
            <DialogDescription>
              Remove <strong>{confirmDelete?.name}</strong>. Events will no longer fan out to its webhook.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Keep</Button>
            <Button variant="destructive" onClick={removeChannel}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Test result */}
      <Dialog open={!!testResult} onOpenChange={(o) => { if (!o) setTestResult(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {testResult?.ok
                ? <><CheckCircle2 className="h-4 w-4 text-green-600" /> Test sent</>
                : <><AlertTriangle className="h-4 w-4 text-destructive" /> Test failed</>}
              <span className="text-sm font-normal text-muted-foreground">— {testResult?.name}</span>
            </DialogTitle>
            <DialogDescription>
              HTTP {testResult?.status}. Check the target channel to confirm the message arrived.
            </DialogDescription>
          </DialogHeader>
          {testResult?.body && (
            <pre className="max-h-60 overflow-auto rounded-md border bg-muted p-3 text-xs font-mono whitespace-pre-wrap">
              {testResult.body}
            </pre>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestResult(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
