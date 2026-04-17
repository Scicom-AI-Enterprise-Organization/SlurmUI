"use client";

import { useRef, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
import { Loader2, Plus, UserPlus, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface ClusterUserRow {
  id: string;
  status: "PENDING" | "ACTIVE" | "FAILED" | "REMOVED";
  provisionedAt: string | null;
  user: { id: string; email: string; name: string | null; unixUid: number | null };
}

interface AllUser { id: string; email: string; name: string | null }

interface UsersTabProps { clusterId: string }

function StatusBadge({ status }: { status: string }) {
  if (status === "ACTIVE") return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Active</Badge>;
  if (status === "FAILED") return <Badge variant="destructive">Failed</Badge>;
  if (status === "REMOVED") return <Badge variant="secondary">Removed</Badge>;
  return <Badge variant="outline">Pending</Badge>;
}

export function UsersTab({ clusterId }: UsersTabProps) {
  const [clusterUsers, setClusterUsers] = useState<ClusterUserRow[]>([]);
  const [allUsers, setAllUsers] = useState<AllUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [running, setRunning] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logStatus, setLogStatus] = useState<"running" | "success" | "failed">("running");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<ClusterUserRow | null>(null);
  const [removeLogOpen, setRemoveLogOpen] = useState(false);
  const [removeLogs, setRemoveLogs] = useState<string[]>([]);
  const [removeLogStatus, setRemoveLogStatus] = useState<"running" | "success" | "failed">("running");
  const [removeTargetLabel, setRemoveTargetLabel] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const removeLogRef = useRef<HTMLDivElement>(null);

  const fetchClusterUsers = () =>
    fetch(`/api/clusters/${clusterId}/users`)
      .then((r) => r.json())
      .then(setClusterUsers)
      .catch(() => {});

  useEffect(() => {
    fetchClusterUsers();
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
          fetchClusterUsers();
          onDone?.();
        } else if (task.status === "failed") {
          setLogStatus("failed");
          clearInterval(poll);
          setRunning(false);
          fetchClusterUsers();
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
          fetchClusterUsers();
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

  const handleRemove = async (userId: string) => {
    const target = confirmRemove;
    setConfirmRemove(null);
    setRemoving(userId);
    setRemoveTargetLabel(target?.user.name ?? target?.user.email ?? "user");
    setRemoveLogs(["[aura] Removing user from cluster..."]);
    setRemoveLogStatus("running");
    setRemoveLogOpen(true);

    const res = await fetch(`/api/clusters/${clusterId}/users/${userId}`, { method: "DELETE" });
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
            fetchClusterUsers();
          } else if (t.status === "failed") {
            setRemoveLogStatus("failed");
            clearInterval(poll);
            setRemoving(null);
            fetchClusterUsers();
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
            fetchClusterUsers();
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
      fetchClusterUsers();
    }
  };

  const alreadyProvisioned = new Set(
    clusterUsers.filter((cu) => cu.status !== "REMOVED").map((cu) => cu.user.id)
  );
  const availableUsers = allUsers.filter((u) => !alreadyProvisioned.has(u.id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{clusterUsers.filter(c => c.status !== "REMOVED").length} user(s) provisioned</p>
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

      {clusterUsers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Plus className="mb-2 h-8 w-8" />
            <p>No users provisioned yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-2 text-left font-medium">User</th>
                <th className="px-4 py-2 text-left font-medium">UID</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Provisioned</th>
                <th className="px-4 py-2 text-left font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {clusterUsers.map((cu) => (
                <tr key={cu.id} className="border-b last:border-0">
                  <td className="px-4 py-2">
                    <div>{cu.user.name ?? cu.user.email}</div>
                    <div className="text-xs text-muted-foreground">{cu.user.email}</div>
                  </td>
                  <td className="px-4 py-2 font-mono">{cu.user.unixUid ?? "—"}</td>
                  <td className="px-4 py-2"><StatusBadge status={cu.status} /></td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {cu.provisionedAt ? new Date(cu.provisionedAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-2">
                    {cu.status !== "REMOVED" && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Remove user"
                        onClick={() => setConfirmRemove(cu)}
                        disabled={removing === cu.user.id}
                      >
                        {removing === cu.user.id
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Trash2 className="h-4 w-4 text-destructive" />}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Remove user confirmation dialog */}
      <Dialog open={!!confirmRemove} onOpenChange={(o) => { if (!o) setConfirmRemove(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove user from cluster?</DialogTitle>
            <DialogDescription>
              This will remove the Linux user <strong>{confirmRemove?.user.name ?? confirmRemove?.user.email}</strong> from
              the controller and all worker nodes, along with their Slurm accounting records.
              The NFS home directory is preserved so their data is not lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => confirmRemove && handleRemove(confirmRemove.user.id)}>
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
