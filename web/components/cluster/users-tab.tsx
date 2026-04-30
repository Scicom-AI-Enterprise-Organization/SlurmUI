"use client";

import { useRef, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Loader2, Plus, UserPlus, Trash2, RefreshCw, Link2 } from "lucide-react";
import { toast } from "sonner";

interface ClusterUserRow {
  id: string;
  status: "PENDING" | "ACTIVE" | "FAILED" | "REMOVED";
  provisionedAt: string | null;
  user: { id: string; email: string; name: string | null; unixUid: number | null; unixUsername: string | null };
}

interface SlurmUserRow {
  user: string;
  uid: number | null;
  home: string | null;
  shell: string | null;
  linuxPresent: boolean;
  slurmPresent: boolean;
  defaultAccount: string;
  defaultQos: string;
  admin: string;
}

interface AllUser { id: string; email: string; name: string | null }

interface UsersTabProps { clusterId: string }

export function UsersTab({ clusterId }: UsersTabProps) {
  const [clusterUsers, setClusterUsers] = useState<ClusterUserRow[]>([]);
  const [slurmUsers, setSlurmUsers] = useState<SlurmUserRow[]>([]);
  const [slurmLoading, setSlurmLoading] = useState(false);
  const [slurmErr, setSlurmErr] = useState<string | null>(null);
  const [allUsers, setAllUsers] = useState<AllUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [running, setRunning] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logStatus, setLogStatus] = useState<"running" | "success" | "failed">("running");
  const [dialogOpen, setDialogOpen] = useState(false);
  // confirmRemove is a discriminated union — managed rows reuse the existing
  // /users/<userId> DELETE; unmanaged rows (no Aura User row, only Linux/Slurm
  // on the controller) hit /slurm-users/<username> which deprovisions by
  // username with no Prisma lookup.
  const [confirmRemove, setConfirmRemove] = useState<
    | { kind: "managed"; row: ClusterUserRow }
    | { kind: "unmanaged"; username: string; uid: number | null }
    | null
  >(null);
  const [removeLogOpen, setRemoveLogOpen] = useState(false);
  const [removeLogs, setRemoveLogs] = useState<string[]>([]);
  const [removeLogStatus, setRemoveLogStatus] = useState<"running" | "success" | "failed">("running");
  const [removeTargetLabel, setRemoveTargetLabel] = useState("");
  // Adopt-a-Linux-account flow: link an existing controller-side user
  // to an Aura User row (sets unixUsername/Uid/Gid + ClusterUser=ACTIVE).
  // Pure DB-side — never touches the controller.
  const [adoptTarget, setAdoptTarget] = useState<{ username: string; uid: number | null } | null>(null);
  const [adoptUserId, setAdoptUserId] = useState<string>("");
  const [adoptSubmitting, setAdoptSubmitting] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const removeLogRef = useRef<HTMLDivElement>(null);

  const fetchClusterUsers = () =>
    fetch(`/api/clusters/${clusterId}/users`)
      .then((r) => r.json())
      .then(setClusterUsers)
      .catch(() => {});

  const fetchSlurmUsers = async () => {
    setSlurmLoading(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/slurm-users`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setSlurmUsers(d.users ?? []);
      setSlurmErr(null);
    } catch (e) {
      setSlurmErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setSlurmLoading(false);
    }
  };

  const refresh = async () => {
    await Promise.all([fetchClusterUsers(), fetchSlurmUsers()]);
  };

  useEffect(() => {
    refresh();
    fetch("/api/users")
      .then((r) => r.json())
      .then(setAllUsers)
      .catch(() => {});
  }, [clusterId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (removeLogRef.current) removeLogRef.current.scrollTop = removeLogRef.current.scrollHeight;
  }, [removeLogs]);

  const pollTask = (taskId: string, onDone?: () => void) => {
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}`);
        if (!r.ok) return;
        const task = await r.json();
        setLogs(task.logs ? task.logs.split("\n") : []);
        if (task.status === "success") {
          setLogStatus("success");
          clearInterval(poll);
          setRunning(false);
          refresh();
          onDone?.();
        } else if (task.status === "failed") {
          setLogStatus("failed");
          clearInterval(poll);
          setRunning(false);
          refresh();
          onDone?.();
        }
      } catch {}
    }, 2000);
  };

  const streamSSE = (requestId: string, userId: string | null) => {
    const evt = new EventSource(`/api/clusters/${clusterId}/stream/${requestId}`);
    evt.onmessage = async (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === "stream") {
          setLogs((p) => [...p, ev.line]);
        } else if (ev.type === "complete") {
          evt.close();
          setLogStatus(ev.success ? "success" : "failed");
          setRunning(false);
          if (userId && ev.success) {
            await fetch(`/api/clusters/${clusterId}/users/${userId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "ACTIVE" }),
            });
          } else if (userId) {
            await fetch(`/api/clusters/${clusterId}/users/${userId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "FAILED" }),
            });
          }
          refresh();
        }
      } catch {}
    };
    evt.onerror = () => {
      evt.close();
      setLogStatus("failed");
      setRunning(false);
    };
  };

  const handleProvision = async () => {
    if (!selectedUserId) return;
    setRunning(true);
    setLogs(["[aura] Starting user provisioning..."]);
    setLogStatus("running");

    const res = await fetch(`/api/clusters/${clusterId}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: selectedUserId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setLogs((p) => [...p, `[error] ${err.error}`]);
      setLogStatus("failed");
      setRunning(false);
      return;
    }

    const data = await res.json();
    if (data.taskId) {
      pollTask(data.taskId);
    } else if (data.request_id) {
      streamSSE(data.request_id, selectedUserId);
    }
  };

  const handleAdopt = async () => {
    if (!adoptTarget || !adoptUserId) return;
    setAdoptSubmitting(true);
    setAdoptError(null);
    try {
      const res = await fetch(
        `/api/clusters/${clusterId}/slurm-users/${encodeURIComponent(adoptTarget.username)}/adopt`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: adoptUserId }),
        },
      );
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAdoptError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      toast.success(`Linked ${adoptTarget.username} to Aura user`);
      setAdoptTarget(null);
      setAdoptUserId("");
      refresh();
    } catch (e) {
      setAdoptError(e instanceof Error ? e.message : "Network error");
    } finally {
      setAdoptSubmitting(false);
    }
  };

  const handleRemove = async () => {
    const target = confirmRemove;
    if (!target) return;
    setConfirmRemove(null);

    // The endpoint differs between managed and unmanaged. Display label
    // (the dialog title) is also computed differently — for unmanaged
    // rows we only have the Linux username.
    const url = target.kind === "managed"
      ? `/api/clusters/${clusterId}/users/${target.row.user.id}`
      : `/api/clusters/${clusterId}/slurm-users/${encodeURIComponent(target.username)}`;
    const removingKey = target.kind === "managed" ? target.row.user.id : `unm:${target.username}`;
    const label = target.kind === "managed"
      ? (target.row.user.name ?? target.row.user.email ?? "user")
      : `${target.username} (unmanaged)`;

    setRemoving(removingKey);
    setRemoveTargetLabel(label);
    setRemoveLogs(["[aura] Removing user from cluster..."]);
    setRemoveLogStatus("running");
    setRemoveLogOpen(true);

    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setRemoveLogs((p) => [...p, `[error] ${err.error ?? "Failed to remove user"}`]);
      setRemoveLogStatus("failed");
      setRemoving(null);
      toast.error("Failed to remove user");
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (data.taskId) {
      const poll = setInterval(async () => {
        try {
          const r = await fetch(`/api/tasks/${data.taskId}`);
          if (!r.ok) return;
          const t = await r.json();
          setRemoveLogs(t.logs ? t.logs.split("\n") : []);
          if (t.status === "success") {
            setRemoveLogStatus("success");
            clearInterval(poll);
            setRemoving(null);
            refresh();
          } else if (t.status === "failed") {
            setRemoveLogStatus("failed");
            clearInterval(poll);
            setRemoving(null);
            refresh();
          }
        } catch {}
      }, 2000);
    } else if (data.request_id) {
      const evt = new EventSource(`/api/clusters/${clusterId}/stream/${data.request_id}`);
      evt.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type === "stream") {
            setRemoveLogs((p) => [...p, ev.line]);
          } else if (ev.type === "complete") {
            setRemoveLogStatus(ev.success ? "success" : "failed");
            evt.close();
            setRemoving(null);
            refresh();
          }
        } catch {}
      };
      evt.onerror = () => {
        evt.close();
        setRemoveLogStatus("failed");
        setRemoving(null);
      };
    } else {
      setRemoveLogStatus("success");
      setRemoving(null);
      refresh();
    }
  };

  const alreadyProvisioned = new Set(
    clusterUsers.filter((cu) => cu.status !== "REMOVED").map((cu) => cu.user.id)
  );
  const availableUsers = allUsers.filter((u) => !alreadyProvisioned.has(u.id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={refresh} disabled={slurmLoading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${slurmLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        <Button onClick={() => setDialogOpen(true)}>
          <UserPlus className="mr-2 h-4 w-4" />
          Add User
        </Button>
        <Dialog open={dialogOpen} onOpenChange={running ? undefined : setDialogOpen}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle className="flex items-center justify-between pr-8">
                Provision User
                {logs.length > 0 && (
                  <Badge className={
                    logStatus === "running" ? "bg-blue-100 text-blue-800" :
                    logStatus === "success" ? "bg-green-100 text-green-800" :
                    "bg-red-100 text-red-800"
                  }>
                    {logStatus === "running" ? "Running" : logStatus === "success" ? "Success" : "Failed"}
                  </Badge>
                )}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex gap-2">
                <div className="flex-1">
                  <Select
                    value={selectedUserId}
                    onValueChange={(v) => setSelectedUserId(v ?? "")}
                    disabled={availableUsers.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue
                        placeholder={availableUsers.length === 0 ? "No users available" : "Select a user..."}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {availableUsers.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name ?? u.email} ({u.email})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={handleProvision} disabled={!selectedUserId || running}>
                  {running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Provisioning...</> : "Provision"}
                </Button>
              </div>

              {logs.length > 0 && (
                <div
                  ref={logRef}
                  className="h-[400px] overflow-y-auto rounded-md border bg-black p-3 font-mono text-xs text-green-400"
                >
                  {logs.map((line, i) => (
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
              )}

            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Users on cluster ({slurmUsers.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {slurmErr && <p className="text-sm text-destructive mb-3">{slurmErr}</p>}
          {slurmUsers.length === 0 && !slurmLoading ? (
            <p className="text-center text-muted-foreground py-6">
              No Linux users (uid ≥ 1000) and no Slurm accounting entries on the controller.
              Add a user here to provision one into both.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead className="w-[80px]">UID</TableHead>
                  <TableHead>Home</TableHead>
                  <TableHead className="w-[120px]">Presence</TableHead>
                  <TableHead>Default account</TableHead>
                  <TableHead className="w-[100px]">Admin</TableHead>
                  <TableHead className="w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slurmUsers.map((s) => {
                  // Match Slurm/Linux rows back to a DB ClusterUser so the
                  // existing DELETE flow (which expects a Prisma User id) keeps
                  // working. Drifted rows (Slurm-only / Linux-only) show an
                  // "unmanaged" tag and no remove button — admin can still
                  // clean them up on the controller.
                  const cu = clusterUsers.find(
                    (c) => c.user.unixUsername === s.user && c.status !== "REMOVED",
                  );
                  const presence = [
                    s.linuxPresent ? "linux" : null,
                    s.slurmPresent ? "slurm" : null,
                  ].filter(Boolean).join(" + ") || "none";
                  const drifted = !cu;
                  return (
                    <TableRow key={s.user}>
                      <TableCell>
                        <div className="font-mono text-sm">{s.user}</div>
                        {cu && (
                          <div className="text-xs text-muted-foreground">{cu.user.email}</div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">{s.uid ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[200px]">
                        {s.home ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">
                          {presence}
                        </Badge>
                        {drifted && (
                          <Badge variant="secondary" className="ml-1 text-[10px]">unmanaged</Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{s.defaultAccount || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{s.admin || "—"}</TableCell>
                      <TableCell>
                        {(() => {
                          // Both managed and unmanaged rows are removable. The
                          // unmanaged path skips the Aura DB and only acts on
                          // the controller (`userdel` + `sacctmgr delete`).
                          // Unmanaged rows also get an Adopt button to link
                          // them to an existing Aura user (DB-only, no SSH).
                          const removeKey = cu ? cu.user.id : `unm:${s.user}`;
                          const isRemoving = removing === removeKey;
                          return (
                            <div className="flex items-center gap-1">
                              {!cu && s.linuxPresent && (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  title="Adopt — link this Linux account to an Aura user"
                                  onClick={() => {
                                    setAdoptTarget({ username: s.user, uid: s.uid });
                                    setAdoptUserId("");
                                    setAdoptError(null);
                                  }}
                                >
                                  <Link2 className="h-4 w-4" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                title={cu ? "Remove user" : "Remove unmanaged user (no Aura DB row)"}
                                onClick={() => setConfirmRemove(
                                  cu
                                    ? { kind: "managed", row: cu }
                                    : { kind: "unmanaged", username: s.user, uid: s.uid },
                                )}
                                disabled={isRemoving}
                              >
                                {isRemoving
                                  ? <Loader2 className="h-4 w-4 animate-spin" />
                                  : <Trash2 className="h-4 w-4 text-destructive" />}
                              </Button>
                            </div>
                          );
                        })()}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Adopt-an-unmanaged-user dialog */}
      <Dialog open={!!adoptTarget} onOpenChange={(o) => { if (!o && !adoptSubmitting) { setAdoptTarget(null); setAdoptError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adopt Linux user</DialogTitle>
            <DialogDescription>
              Link the Linux account{" "}
              <code className="font-mono">{adoptTarget?.username}</code>
              {adoptTarget?.uid !== null && adoptTarget?.uid !== undefined ? ` (uid ${adoptTarget.uid})` : ""}{" "}
              to an Aura user. This only updates Aura&apos;s database — the controller is read-only here. After
              adoption, the linked user can submit jobs and access this cluster as if they had been provisioned by Aura.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <label className="text-xs font-medium">Aura user</label>
            <Select value={adoptUserId} onValueChange={setAdoptUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick an Aura user…" />
              </SelectTrigger>
              <SelectContent>
                {allUsers
                  .slice()
                  .sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""))
                  .map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name ? `${u.name} <${u.email}>` : u.email}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {adoptError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {adoptError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdoptTarget(null)} disabled={adoptSubmitting}>
              Cancel
            </Button>
            <Button onClick={handleAdopt} disabled={!adoptUserId || adoptSubmitting}>
              {adoptSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
              Adopt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove user confirmation dialog */}
      <Dialog open={!!confirmRemove} onOpenChange={(o) => { if (!o) setConfirmRemove(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove user from cluster?</DialogTitle>
            <DialogDescription>
              {confirmRemove?.kind === "managed" ? (
                <>
                  This will remove the Linux user{" "}
                  <strong>{confirmRemove.row.user.name ?? confirmRemove.row.user.email}</strong>{" "}
                  from the controller and all worker nodes, along with their Slurm accounting records.
                  The NFS home directory is preserved so their data is not lost.
                </>
              ) : confirmRemove?.kind === "unmanaged" ? (
                <>
                  This Linux user (<strong>{confirmRemove.username}</strong>
                  {confirmRemove.uid !== null ? `, uid ${confirmRemove.uid}` : ""})
                  exists on the controller but isn&apos;t tracked in Aura&apos;s database. Remove
                  will run <code>userdel</code> + <code>sacctmgr delete</code> on the controller and every
                  worker, identical to the managed flow. The NFS home directory is preserved.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => handleRemove()}>
              <Trash2 className="mr-2 h-4 w-4" />
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove user log dialog */}
      <Dialog open={removeLogOpen} onOpenChange={removeLogStatus !== "running" ? setRemoveLogOpen : undefined}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-8">
              Removing {removeTargetLabel}
              <Badge className={
                removeLogStatus === "running" ? "bg-blue-100 text-blue-800" :
                removeLogStatus === "success" ? "bg-green-100 text-green-800" :
                "bg-red-100 text-red-800"
              }>
                {removeLogStatus === "running" ? "Running" : removeLogStatus === "success" ? "Success" : "Failed"}
              </Badge>
            </DialogTitle>
          </DialogHeader>
          <div
            ref={removeLogRef}
            className="h-[500px] overflow-y-auto rounded-md border bg-black p-3 font-mono text-sm text-green-400"
          >
            {removeLogs.map((line, i) => (
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
            {removeLogStatus === "running" && (
              <div className="mt-1 inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Running...
              </div>
            )}
          </div>
          <DialogFooter>
            {removeLogStatus !== "running" && (
              <Button variant="outline" onClick={() => setRemoveLogOpen(false)}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
