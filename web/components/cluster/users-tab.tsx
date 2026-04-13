"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, UserPlus } from "lucide-react";

interface ClusterUserRow {
  id: string;
  status: "PENDING" | "ACTIVE" | "FAILED";
  provisionedAt: string | null;
  user: { id: string; email: string; name: string | null; unixUid: number | null };
}

interface AllUser { id: string; email: string; name: string | null }

interface UsersTabProps { clusterId: string }

function StatusBadge({ status }: { status: string }) {
  if (status === "ACTIVE") return <Badge className="bg-green-100 text-green-700">Active</Badge>;
  if (status === "FAILED") return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="outline">Pending</Badge>;
}

export function UsersTab({ clusterId }: UsersTabProps) {
  const [clusterUsers, setClusterUsers] = useState<ClusterUserRow[]>([]);
  const [allUsers, setAllUsers] = useState<AllUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [provisioning, setProvisioning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

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

  const handleProvision = async () => {
    if (!selectedUserId) return;
    setProvisioning(true);
    setLogs(["[aura] Starting user provisioning..."]);

    const res = await fetch(`/api/clusters/${clusterId}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: selectedUserId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setLogs((p) => [...p, `[error] ${err.error}`]);
      setProvisioning(false);
      return;
    }

    const { request_id } = await res.json();

    const evtSource = new EventSource(`/api/clusters/${clusterId}/stream/${request_id}`);
    evtSource.onmessage = async (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "stream") {
          setLogs((p) => [...p, event.line]);
        } else if (event.type === "complete") {
          evtSource.close();
          const newStatus = event.success ? "ACTIVE" : "FAILED";
          await fetch(`/api/clusters/${clusterId}/users/${selectedUserId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: newStatus }),
          });
          setLogs((p) => [...p, event.success ? "[aura] User provisioned successfully." : `[error] ${event.payload?.error ?? "Provisioning failed"}`]);
          setProvisioning(false);
          fetchClusterUsers();
        }
      } catch {}
    };
    evtSource.onerror = () => {
      evtSource.close();
      setLogs((p) => [...p, "[error] SSE connection lost"]);
      setProvisioning(false);
    };
  };

  const alreadyProvisioned = new Set(clusterUsers.map((cu) => cu.user.id));
  const availableUsers = allUsers.filter((u) => !alreadyProvisioned.has(u.id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{clusterUsers.length} user(s) provisioned</p>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button size="sm" />}>
            <UserPlus className="mr-2 h-4 w-4" /> Add User
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Provision User</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Select value={selectedUserId} onValueChange={(v) => setSelectedUserId(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a user..." />
                </SelectTrigger>
                <SelectContent>
                  {availableUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name ?? u.email} ({u.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {logs.length > 0 && (
                <div className="h-48 overflow-y-auto rounded-md border bg-black p-3 font-mono text-xs text-green-400">
                  {logs.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              )}

              <Button onClick={handleProvision} disabled={!selectedUserId || provisioning} className="w-full">
                {provisioning ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Provisioning...</> : "Provision"}
              </Button>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
