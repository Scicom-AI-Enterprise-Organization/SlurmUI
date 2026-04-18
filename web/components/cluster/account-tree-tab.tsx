"use client";

import { useEffect, useMemo, useState } from "react";
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
import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Trash2, Users as UsersIcon, Pencil, UserPlus } from "lucide-react";

interface UserAssoc {
  user: string;
  partition: string;
  share: string;
  defaultQos: string;
  qos: string;
  maxJobs: string;
  maxSubmit: string;
  grpTres: string;
}
interface Account {
  name: string;
  parent: string;
  share: string;
  defaultQos: string;
  qos: string;
  maxJobs: string;
  maxSubmit: string;
  grpTres: string;
  users: UserAssoc[];
}

type DialogMode =
  | { kind: "none" }
  | { kind: "create-account"; parent: string }
  | { kind: "edit-account"; account: Account }
  | { kind: "add-user"; account: Account }
  | { kind: "edit-user"; account: Account; user: UserAssoc }
  | { kind: "delete-account"; account: Account }
  | { kind: "delete-user"; account: Account; user: UserAssoc }
  | { kind: "result"; ok: boolean; title: string; body: string };

export function AccountTreeTab({ clusterId }: { clusterId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["root"]));
  const [dialog, setDialog] = useState<DialogMode>({ kind: "none" });

  const load = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/accounts`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setAccounts(d.accounts ?? []);
      setErrMsg(null);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setRefreshing(false);
      setLoaded(true);
    }
  };
  useEffect(() => { load(); }, [clusterId]);

  // Build parent → children index. Root accounts are those whose parent is
  // empty or doesn't resolve to any listed account.
  const { childrenOf, roots } = useMemo(() => {
    const map = new Map<string, Account[]>();
    for (const a of accounts) {
      const p = a.parent || "";
      if (!map.has(p)) map.set(p, []);
      map.get(p)!.push(a);
    }
    for (const [, arr] of map) arr.sort((a, b) => a.name.localeCompare(b.name));
    const names = new Set(accounts.map((a) => a.name));
    const r: Account[] = [];
    for (const a of accounts) {
      if (!a.parent || !names.has(a.parent)) r.push(a);
    }
    r.sort((a, b) => a.name.localeCompare(b.name));
    return { childrenOf: map, roots: r };
  }, [accounts]);

  const selectedAccount = accounts.find((a) => a.name === selected) ?? null;
  const siblingsOfSelected = selectedAccount
    ? (childrenOf.get(selectedAccount.parent || "") ?? []).filter((a) => a.name !== selectedAccount.name)
    : [];
  const siblingShareSum = siblingsOfSelected.reduce((s, a) => s + (parseInt(a.share, 10) || 0), 0);
  const selfShare = selectedAccount ? (parseInt(selectedAccount.share, 10) || 0) : 0;
  const fairsharePct = selectedAccount && (siblingShareSum + selfShare) > 0
    ? Math.round((selfShare / (siblingShareSum + selfShare)) * 100)
    : null;

  const toggle = (name: string) => {
    const next = new Set(expanded);
    if (next.has(name)) next.delete(name); else next.add(name);
    setExpanded(next);
  };

  const renderNode = (a: Account, depth: number): React.ReactNode => {
    const kids = childrenOf.get(a.name) ?? [];
    const isOpen = expanded.has(a.name);
    const isSelected = selected === a.name;
    return (
      <div key={a.name}>
        <div
          className={`group flex items-center gap-1 rounded-md py-1 pr-2 text-sm cursor-pointer ${isSelected ? "bg-accent" : "hover:bg-muted/60"}`}
          style={{ paddingLeft: depth * 16 + 4 }}
          onClick={() => setSelected(a.name)}
        >
          <button
            type="button"
            className={`inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted ${kids.length === 0 ? "invisible" : ""}`}
            onClick={(e) => { e.stopPropagation(); toggle(a.name); }}
          >
            {kids.length > 0 && (isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />)}
          </button>
          <span className="font-mono">{a.name}</span>
          {a.share && <span className="ml-1 text-[10px] rounded bg-muted px-1 font-mono text-muted-foreground">share={a.share}</span>}
          {a.users.length > 0 && (
            <span className="ml-1 text-[10px] text-muted-foreground inline-flex items-center gap-0.5">
              <UsersIcon className="h-3 w-3" /> {a.users.length}
            </span>
          )}
        </div>
        {isOpen && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  const runAction = async (url: string, init: RequestInit, title: string) => {
    try {
      const res = await fetch(url, init);
      const d = await res.json();
      if (!res.ok) {
        setDialog({ kind: "result", ok: false, title: `${title} failed`, body: d.error ?? `HTTP ${res.status}` });
      } else {
        setDialog({ kind: "result", ok: true, title, body: d.output || "OK" });
        load();
      }
    } catch (e) {
      setDialog({ kind: "result", ok: false, title: `${title} failed`, body: e instanceof Error ? e.message : "Network error" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={load} disabled={refreshing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </Button>
        <Button onClick={() => setDialog({ kind: "create-account", parent: "root" })}>
          <Plus className="mr-2 h-4 w-4" /> New account
        </Button>
      </div>

      {errMsg && <p className="text-sm text-destructive">{errMsg}</p>}

      <div className="grid gap-4 md:grid-cols-[320px_1fr]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Hierarchy ({accounts.length})</CardTitle>
          </CardHeader>
          <CardContent className="px-1 py-1">
            {!loaded ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">Loading…</p>
            ) : accounts.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                No accounts. Requires <code>slurmdbd</code>.
              </p>
            ) : roots.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">No root accounts found.</p>
            ) : (
              <div className="py-1">{roots.map((r) => renderNode(r, 0))}</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              {selectedAccount ? `Account · ${selectedAccount.name}` : "Select an account"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!selectedAccount ? (
              <p className="text-sm text-muted-foreground">Pick an account from the tree to inspect or edit.</p>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-2 md:grid-cols-3 text-xs">
                  <Field k="Parent" v={selectedAccount.parent || "—"} />
                  <Field
                    k="Fairshare"
                    v={selectedAccount.share || "—"}
                    sub={fairsharePct !== null ? `${fairsharePct}% of siblings` : undefined}
                  />
                  <Field k="Default QoS" v={selectedAccount.defaultQos || "—"} />
                  <Field k="QoS" v={selectedAccount.qos || "—"} />
                  <Field k="GrpTRES" v={selectedAccount.grpTres || "—"} />
                  <Field k="Max jobs / submits" v={`${selectedAccount.maxJobs || "—"} / ${selectedAccount.maxSubmit || "—"}`} />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "edit-account", account: selectedAccount })}>
                    <Pencil className="mr-2 h-3 w-3" /> Edit
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "create-account", parent: selectedAccount.name })}>
                    <Plus className="mr-2 h-3 w-3" /> Add child
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "add-user", account: selectedAccount })}>
                    <UserPlus className="mr-2 h-3 w-3" /> Attach user
                  </Button>
                  <Button
                    size="sm" variant="destructive"
                    disabled={selectedAccount.name.toLowerCase() === "root"}
                    onClick={() => setDialog({ kind: "delete-account", account: selectedAccount })}
                  >
                    <Trash2 className="mr-2 h-3 w-3" /> Delete
                  </Button>
                </div>

                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">User associations ({selectedAccount.users.length})</p>
                  {selectedAccount.users.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None. Click "Attach user" to add one.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>User</TableHead>
                          <TableHead>Partition</TableHead>
                          <TableHead>Share</TableHead>
                          <TableHead>DefaultQOS</TableHead>
                          <TableHead>QOS</TableHead>
                          <TableHead className="w-[100px]">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedAccount.users.map((u) => (
                          <TableRow key={`${u.user}|${u.partition}`}>
                            <TableCell className="font-mono text-sm">{u.user}</TableCell>
                            <TableCell className="font-mono text-xs">{u.partition || "—"}</TableCell>
                            <TableCell className="font-mono text-xs">{u.share || "—"}</TableCell>
                            <TableCell className="font-mono text-xs">{u.defaultQos || "—"}</TableCell>
                            <TableCell className="font-mono text-xs">{u.qos || "—"}</TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                <Button variant="ghost" size="icon-sm" title="Edit"
                                  onClick={() => setDialog({ kind: "edit-user", account: selectedAccount, user: u })}>
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button variant="ghost" size="icon-sm" title="Remove association"
                                  onClick={() => setDialog({ kind: "delete-user", account: selectedAccount, user: u })}>
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Create account */}
      {dialog.kind === "create-account" && (
        <AccountDialog
          mode="create"
          defaults={{ name: "", parent: dialog.parent, share: "", defaultQos: "", qos: "", grpTres: "", maxJobs: "", maxSubmit: "" }}
          onClose={() => setDialog({ kind: "none" })}
          onSubmit={async (values) => {
            await runAction(
              `/api/clusters/${clusterId}/accounts`,
              { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) },
              `Create ${values.name}`,
            );
          }}
        />
      )}
      {dialog.kind === "edit-account" && (
        <AccountDialog
          mode="edit"
          defaults={{
            name: dialog.account.name,
            parent: dialog.account.parent,
            share: dialog.account.share,
            defaultQos: dialog.account.defaultQos,
            qos: dialog.account.qos,
            grpTres: dialog.account.grpTres,
            maxJobs: dialog.account.maxJobs,
            maxSubmit: dialog.account.maxSubmit,
          }}
          onClose={() => setDialog({ kind: "none" })}
          onSubmit={async (values) => {
            await runAction(
              `/api/clusters/${clusterId}/accounts/${dialog.account.name}`,
              { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) },
              `Update ${dialog.account.name}`,
            );
          }}
        />
      )}
      {dialog.kind === "add-user" && (
        <UserAssocDialog
          mode="create"
          account={dialog.account.name}
          defaults={{ user: "", partition: "", share: "", defaultQos: "", qos: "" }}
          onClose={() => setDialog({ kind: "none" })}
          onSubmit={async (values) => {
            await runAction(
              `/api/clusters/${clusterId}/accounts/${dialog.account.name}/users`,
              { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) },
              `Attach ${values.user}`,
            );
          }}
        />
      )}
      {dialog.kind === "edit-user" && (
        <UserAssocDialog
          mode="edit"
          account={dialog.account.name}
          defaults={{
            user: dialog.user.user,
            partition: dialog.user.partition,
            share: dialog.user.share,
            defaultQos: dialog.user.defaultQos,
            qos: dialog.user.qos,
          }}
          onClose={() => setDialog({ kind: "none" })}
          onSubmit={async (values) => {
            await runAction(
              `/api/clusters/${clusterId}/accounts/${dialog.account.name}/users/${dialog.user.user}`,
              { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) },
              `Update ${dialog.user.user}`,
            );
          }}
        />
      )}

      {/* Confirm deletes */}
      <Dialog open={dialog.kind === "delete-account"} onOpenChange={(o) => { if (!o) setDialog({ kind: "none" }); }}>
        {dialog.kind === "delete-account" && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete account {dialog.account.name}?</DialogTitle>
              <DialogDescription>
                Runs <code>sacctmgr delete account where name={dialog.account.name}</code>.
                Fails if the account has children or user associations — remove those first.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button variant="destructive"
                onClick={() => dialog.kind === "delete-account" && runAction(
                  `/api/clusters/${clusterId}/accounts/${dialog.account.name}`,
                  { method: "DELETE" },
                  `Delete ${dialog.account.name}`,
                )}
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={dialog.kind === "delete-user"} onOpenChange={(o) => { if (!o) setDialog({ kind: "none" }); }}>
        {dialog.kind === "delete-user" && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove {dialog.user.user} from {dialog.account.name}?</DialogTitle>
              <DialogDescription>
                Removes just this association. The Linux user and any other account memberships stay intact.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button variant="destructive"
                onClick={() => dialog.kind === "delete-user" && runAction(
                  `/api/clusters/${clusterId}/accounts/${dialog.account.name}/users/${dialog.user.user}`,
                  { method: "DELETE" },
                  `Remove ${dialog.user.user}`,
                )}
              >
                <Trash2 className="mr-2 h-4 w-4" /> Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={dialog.kind === "result"} onOpenChange={(o) => { if (!o) setDialog({ kind: "none" }); }}>
        {dialog.kind === "result" && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle className={dialog.ok ? "" : "text-destructive"}>{dialog.title}</DialogTitle>
            </DialogHeader>
            <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
              {dialog.body}
            </pre>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog({ kind: "none" })}>Close</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function Field({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</p>
      <p className="font-mono text-sm">{v}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

interface AccountValues {
  name: string;
  parent: string;
  share: string;
  defaultQos: string;
  qos: string;
  grpTres: string;
  maxJobs: string;
  maxSubmit: string;
}

function AccountDialog({
  mode, defaults, onClose, onSubmit,
}: {
  mode: "create" | "edit";
  defaults: AccountValues;
  onClose: () => void;
  onSubmit: (v: AccountValues) => Promise<void>;
}) {
  const [v, setV] = useState(defaults);
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New account" : `Edit ${defaults.name}`}</DialogTitle>
          <DialogDescription>
            Wraps <code>sacctmgr {mode === "create" ? "add" : "modify"} account</code>. Empty fields
            are unchanged on edit; <code>-1</code> clears a limit.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          {mode === "create" && (
            <Row label="Name"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="research-ml" /></Row>
          )}
          <Row label="Parent"><Input value={v.parent} onChange={(e) => setV({ ...v, parent: e.target.value })} placeholder="root" /></Row>
          <Row label="Fairshare"><Input value={v.share} onChange={(e) => setV({ ...v, share: e.target.value })} placeholder="100" /></Row>
          <Row label="Default QoS"><Input value={v.defaultQos} onChange={(e) => setV({ ...v, defaultQos: e.target.value })} placeholder="normal" /></Row>
          <Row label="QoS (comma list)"><Input value={v.qos} onChange={(e) => setV({ ...v, qos: e.target.value })} placeholder="normal,research-high" /></Row>
          <Row label="GrpTRES"><Input value={v.grpTres} onChange={(e) => setV({ ...v, grpTres: e.target.value })} placeholder="cpu=256,gres/gpu=16" /></Row>
          <Row label="MaxJobs"><Input value={v.maxJobs} onChange={(e) => setV({ ...v, maxJobs: e.target.value })} placeholder="50" /></Row>
          <Row label="MaxSubmit"><Input value={v.maxSubmit} onChange={(e) => setV({ ...v, maxSubmit: e.target.value })} placeholder="500" /></Row>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button
            disabled={saving || (mode === "create" && !v.name)}
            onClick={async () => { setSaving(true); try { await onSubmit(v); } finally { setSaving(false); } }}
          >
            {saving
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{mode === "create" ? "Creating..." : "Saving..."}</>
              : (mode === "create" ? "Create" : "Save changes")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface UserAssocValues {
  user: string;
  partition: string;
  share: string;
  defaultQos: string;
  qos: string;
}

function UserAssocDialog({
  mode, account, defaults, onClose, onSubmit,
}: {
  mode: "create" | "edit";
  account: string;
  defaults: UserAssocValues;
  onClose: () => void;
  onSubmit: (v: UserAssocValues) => Promise<void>;
}) {
  const [v, setV] = useState(defaults);
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? `Attach user to ${account}` : `Edit ${defaults.user} in ${account}`}
          </DialogTitle>
          <DialogDescription>
            Creates an association row via <code>sacctmgr {mode === "create" ? "add" : "modify"} user</code>.
            The Linux user must already exist — use the Users tab to provision them first.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          {mode === "create" && (
            <Row label="Unix username">
              <Input value={v.user} onChange={(e) => setV({ ...v, user: e.target.value })} placeholder="alice" />
            </Row>
          )}
          <Row label="Partition (optional)">
            <Input value={v.partition} onChange={(e) => setV({ ...v, partition: e.target.value })} placeholder="gpu" />
          </Row>
          <Row label="Fairshare"><Input value={v.share} onChange={(e) => setV({ ...v, share: e.target.value })} placeholder="1" /></Row>
          <Row label="Default QoS"><Input value={v.defaultQos} onChange={(e) => setV({ ...v, defaultQos: e.target.value })} placeholder="normal" /></Row>
          <Row label="QoS (comma list)"><Input value={v.qos} onChange={(e) => setV({ ...v, qos: e.target.value })} placeholder="normal,research-high" /></Row>
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button
            disabled={saving || (mode === "create" && !v.user)}
            onClick={async () => { setSaving(true); try { await onSubmit(v); } finally { setSaving(false); } }}
          >
            {saving
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{mode === "create" ? "Attaching..." : "Saving..."}</>
              : (mode === "create" ? "Attach" : "Save changes")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
