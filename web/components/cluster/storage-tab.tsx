"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Plus, Trash2, Loader2, Check, X, Plug, Server, LockOpen } from "lucide-react";
import { toast } from "sonner";

interface StorageMount {
  id: string;
  type: "nfs" | "s3fs";
  mountPath: string;
  nfsServer?: string;
  nfsPath?: string;
  /**
   * Optional reference into cluster.config.nfs_servers. When set, this mount
   * sources from a self-hosted NFS server. Implies deploy mounts on every
   * cluster node (server included), so the path resolves uniformly.
   */
  nfsServerId?: string;
  s3Bucket?: string;
  s3Endpoint?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Region?: string;
}

interface NfsServer {
  id: string;
  hostNode: string;       // cluster node hostname
  exportPath: string;     // path on that node (e.g. /srv/aura-nfs)
  allowedNetwork: string; // /etc/exports allow list — CIDR, hostname, or "*"
}

interface ClusterNode {
  hostname: string;
  ip: string;
  user?: string;
  port?: number;
}

interface StorageTabProps {
  clusterId: string;
  initialMounts: StorageMount[];
  initialNfsServers: NfsServer[];
  nodes: ClusterNode[];
}

type LogContext = "mount-deploy" | "mount-remove" | "nfs-deploy" | "nfs-remove";

export function StorageTab({
  clusterId,
  initialMounts,
  initialNfsServers,
  nodes,
}: StorageTabProps) {
  const [mounts, setMounts] = useState<StorageMount[]>(initialMounts);
  const [servers, setServers] = useState<NfsServer[]>(initialNfsServers);

  // Shared deploy-log dialog state (used by mount AND NFS-server actions).
  const [deployLogOpen, setDeployLogOpen] = useState(false);
  const [deployLines, setDeployLines] = useState<string[]>([]);
  const [deployStatus, setDeployStatus] = useState<"running" | "success" | "failed">("running");
  const [deployTitle, setDeployTitle] = useState("Operation");
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Which row is currently busy — used to disable buttons. We key both
  // mounts and servers by a tag like "mount:<id>" / "server:<id>" so they
  // never collide.
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Mount-related state.
  const [addOpen, setAddOpen] = useState(false);
  const [mountStatuses, setMountStatuses] = useState<Record<string, Record<string, string>>>({});
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [targetHosts, setTargetHosts] = useState<string[]>([]);
  const [confirmRemoveMount, setConfirmRemoveMount] = useState<StorageMount | null>(null);
  // "Fix Permissions" dialog state.
  const [chmodMount, setChmodMount] = useState<StorageMount | null>(null);
  const [chmodMode, setChmodMode] = useState("0777");
  const [chmodRecursive, setChmodRecursive] = useState(false);

  // NFS-server-related state.
  const [createServerOpen, setCreateServerOpen] = useState(false);
  const [newServerHost, setNewServerHost] = useState("");
  const [newServerExportPath, setNewServerExportPath] = useState("/srv/aura-nfs");
  const [newServerAllowed, setNewServerAllowed] = useState("*");
  const [confirmRemoveServer, setConfirmRemoveServer] = useState<NfsServer | null>(null);

  // Add-mount form.
  const [newType, setNewType] = useState<"nfs" | "s3fs">("nfs");
  const [newMountPath, setNewMountPath] = useState("/mnt/shared");
  /**
   * NFS mount source. "external" means user types server IP + path; any
   * other value is the id of a self-hosted NFS server.
   */
  const [newNfsSourceId, setNewNfsSourceId] = useState<string>("external");
  const [newNfsServer, setNewNfsServer] = useState("");
  const [newNfsPath, setNewNfsPath] = useState("");
  const [newS3Bucket, setNewS3Bucket] = useState("");
  const [newS3Endpoint, setNewS3Endpoint] = useState("");
  const [newS3AccessKey, setNewS3AccessKey] = useState("");
  const [newS3SecretKey, setNewS3SecretKey] = useState("");
  const [newS3Region, setNewS3Region] = useState("us-east-1");

  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "failed">("idle");
  const [testMsg, setTestMsg] = useState("");
  const [testNodes, setTestNodes] = useState<Array<{ hostname: string; ok: boolean; detail: string }>>([]);

  const resetForm = () => {
    setNewType("nfs");
    setNewMountPath("/mnt/shared");
    setNewNfsSourceId("external");
    setNewNfsServer("");
    setNewNfsPath("");
    setNewS3Bucket("");
    setNewS3Endpoint("");
    setNewS3AccessKey("");
    setNewS3SecretKey("");
    setNewS3Region("us-east-1");
    setTestStatus("idle");
    setTestMsg("");
  };

  const resetTest = () => {
    setTestStatus("idle");
    setTestMsg("");
    setTestNodes([]);
  };

  const fetchStatuses = async () => {
    if (mounts.length === 0) return;
    setCheckingStatus(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/storage/status`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setMountStatuses(data.statuses ?? {});
        setTargetHosts(data.targets ?? []);
      }
    } catch {} finally {
      setCheckingStatus(false);
    }
  };

  useEffect(() => {
    fetchStatuses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounts.length, clusterId]);

  // `crypto.randomUUID` is only exposed in secure contexts. Browser-side
  // fallback so plain-HTTP admin deployments still get unique ids.
  const genId = (prefix = "id") => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  };

  // Persist a partial config update. Both storage_mounts and nfs_servers
  // round-trip through this single endpoint so we don't have to invent a new
  // PATCH shape per field.
  const saveConfig = async (patch: { storage_mounts?: StorageMount[]; nfs_servers?: NfsServer[] }) => {
    const res = await fetch(`/api/clusters/${clusterId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: patch }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      toast.error(err.error ?? "Failed to save");
    }
  };

  // ---- Realtime log polling, shared between mount + NFS-server ops ----

  // One outstanding poller per component. Keeping a ref means:
  //   - starting a new op while one is running clears the old interval
  //     (otherwise both would keep firing on the same taskId — that's the
  //     "5 GETs in a burst" pattern in the dev logs)
  //   - leaving the page / unmount kills the poller
  //   - closing the deploy-log dialog stops the polling immediately even
  //     if the task itself is still running on the server
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Callback to run when the polled task succeeds. Kept in a ref so we can
  // (a) start polling without re-running the closure on every render, and
  // (b) restart polling on dialog reopen without re-supplying the callback.
  const onSuccessRef = useRef<(() => void | Promise<void>) | null>(null);

  const stopPolling = () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => stopPolling, []);

  // 3s — fast enough to feel live, slow enough to avoid hammering the API
  // when an op runs for minutes (recursive s3fs chmod is the worst case).
  const startPolling = (taskId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}`);
        if (!r.ok) return;
        const t = await r.json();
        setDeployLines(t.logs ? t.logs.split("\n") : []);
        if (t.status === "success") {
          setDeployStatus("success");
          stopPolling();
          setBusyKey(null);
          setCurrentTaskId(null);
          setCancelling(false);
          if (onSuccessRef.current) await onSuccessRef.current();
          onSuccessRef.current = null;
          setTimeout(fetchStatuses, 1000);
        } else if (t.status === "failed") {
          setDeployStatus("failed");
          stopPolling();
          setBusyKey(null);
          setCurrentTaskId(null);
          setCancelling(false);
          onSuccessRef.current = null;
        }
      } catch {}
    }, 3000);
  };

  const attachToTask = (
    taskId: string,
    busyTag: string,
    ctx: LogContext,
    onSuccess?: () => void | Promise<void>,
  ) => {
    setBusyKey(busyTag);
    setCurrentTaskId(taskId);
    setCancelling(false);
    setDeployLines([]);
    setDeployStatus("running");
    setDeployLogOpen(true);
    setDeployTitle(
      ctx === "mount-deploy" ? "Deploying mount" :
      ctx === "mount-remove" ? "Removing mount" :
      ctx === "nfs-deploy" ? "Provisioning NFS server" :
      "Removing NFS server"
    );
    onSuccessRef.current = onSuccess ?? null;
    startPolling(taskId);
  };

  const handleCancelDeploy = async () => {
    if (!currentTaskId) return;
    setCancelling(true);
    try {
      await fetch(`/api/tasks/${currentTaskId}/cancel`, { method: "POST" });
    } catch {
      setCancelling(false);
    }
  };

  // ---- NFS Server actions ----

  const handleCreateServer = async () => {
    const node = nodes.find((n) => n.hostname === newServerHost);
    if (!node) {
      toast.error("Pick a host node.");
      return;
    }
    if (!newServerExportPath.startsWith("/")) {
      toast.error("Export path must be absolute.");
      return;
    }
    if (servers.some((s) => s.hostNode === node.hostname && s.exportPath === newServerExportPath)) {
      toast.error(`${node.hostname} already exports ${newServerExportPath}.`);
      return;
    }
    const server: NfsServer = {
      id: genId("nfs"),
      hostNode: node.hostname,
      exportPath: newServerExportPath,
      allowedNetwork: newServerAllowed || "*",
    };
    // Save the entry first so the user can re-deploy from the list if the
    // initial provision fails.
    const updated = [...servers, server];
    setServers(updated);
    setCreateServerOpen(false);
    setNewServerHost("");
    setNewServerExportPath("/srv/aura-nfs");
    setNewServerAllowed("*");
    await saveConfig({ nfs_servers: updated });
    await deployServer(server);
  };

  const deployServer = async (server: NfsServer) => {
    const res = await fetch(`/api/clusters/${clusterId}/storage/nfs-server`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server, action: "deploy" }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setDeployStatus("failed");
      setDeployLines([`[error] ${err.error ?? "Failed to start"}`]);
      setDeployTitle("Provisioning NFS server");
      setDeployLogOpen(true);
      return;
    }
    const { taskId } = await res.json();
    attachToTask(taskId, `server:${server.id}`, "nfs-deploy");
  };

  const doRemoveServer = async () => {
    const server = confirmRemoveServer;
    if (!server) return;
    setConfirmRemoveServer(null);

    const referencing = mounts.filter((m) => m.nfsServerId === server.id);
    if (referencing.length > 0) {
      toast.error(
        `Mount${referencing.length > 1 ? "s" : ""} still reference this server: ${referencing.map((m) => m.mountPath).join(", ")}. Remove them first.`,
      );
      return;
    }

    const res = await fetch(`/api/clusters/${clusterId}/storage/nfs-server`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server, action: "remove" }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setDeployStatus("failed");
      setDeployLines([`[error] ${err.error ?? "Failed to remove"}`]);
      setDeployTitle("Removing NFS server");
      setDeployLogOpen(true);
      return;
    }
    const { taskId } = await res.json();
    attachToTask(taskId, `server:${server.id}`, "nfs-remove", async () => {
      const updated = servers.filter((s) => s.id !== server.id);
      setServers(updated);
      await saveConfig({ nfs_servers: updated });
    });
  };

  // ---- Mount actions ----

  const handleAdd = async () => {
    if (mountPathClash) {
      toast.error(`Mount path ${normPath(newMountPath)} is already in use.`);
      return;
    }
    let nfsFields: Partial<StorageMount> = {};
    if (newType === "nfs") {
      if (newNfsSourceId === "external") {
        nfsFields = { nfsServer: newNfsServer, nfsPath: newNfsPath };
      } else {
        const src = servers.find((s) => s.id === newNfsSourceId);
        const host = src ? nodes.find((n) => n.hostname === src.hostNode) : undefined;
        if (!src || !host) {
          toast.error("Selected NFS server is no longer available.");
          return;
        }
        nfsFields = {
          nfsServer: host.ip,
          nfsPath: src.exportPath,
          nfsServerId: src.id,
        };
      }
    }
    const mount: StorageMount = {
      id: genId("mnt"),
      type: newType,
      mountPath: newMountPath,
      ...(newType === "nfs" ? nfsFields : {
        s3Bucket: newS3Bucket,
        s3Endpoint: newS3Endpoint || undefined,
        s3AccessKey: newS3AccessKey,
        s3SecretKey: newS3SecretKey,
        s3Region: newS3Region,
      }),
    };
    const updated = [...mounts, mount];
    setMounts(updated);
    setAddOpen(false);
    resetForm();
    await saveConfig({ storage_mounts: updated });
  };

  const handleDeploy = async (mount: StorageMount) => {
    const busyTag = `mount:${mount.id}`;
    if (busyKey === busyTag && currentTaskId) {
      setDeployLogOpen(true);
      return;
    }
    const res = await fetch(`/api/clusters/${clusterId}/storage/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mount }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setDeployStatus("failed");
      setDeployLines((prev) => [...prev, `[error] ${err.error ?? "Failed to start"}`]);
      setDeployTitle("Deploying mount");
      setDeployLogOpen(true);
      return;
    }
    const { taskId } = await res.json();
    attachToTask(taskId, busyTag, "mount-deploy");
  };

  const runChmod = async () => {
    const mount = chmodMount;
    if (!mount) return;
    const mode = chmodMode.trim();
    const recursive = chmodRecursive;
    setChmodMount(null);

    const res = await fetch(`/api/clusters/${clusterId}/storage/chmod`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mountId: mount.id, mode, recursive }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setDeployStatus("failed");
      setDeployLines([`[error] ${err.error ?? "Failed to start"}`]);
      setDeployTitle("Fixing permissions");
      setDeployLogOpen(true);
      return;
    }
    const { taskId } = await res.json();
    attachToTask(taskId, `mount:${mount.id}`, "mount-deploy");
    setDeployTitle("Fixing permissions");
  };

  const doRemoveMount = async () => {
    const mount = confirmRemoveMount;
    if (!mount) return;
    setConfirmRemoveMount(null);

    const res = await fetch(`/api/clusters/${clusterId}/storage/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mount, action: "remove" }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setDeployStatus("failed");
      setDeployLines([`[error] ${err.error ?? "Failed to remove"}`]);
      setDeployTitle("Removing mount");
      setDeployLogOpen(true);
      return;
    }
    const { taskId } = await res.json();
    attachToTask(taskId, `mount:${mount.id}`, "mount-remove", async () => {
      const updated = mounts.filter((m) => m.id !== mount.id);
      setMounts(updated);
      await saveConfig({ storage_mounts: updated });
    });
  };

  // Treat "/mnt/shared" and "/mnt/shared/" as the same target so we don't
  // let two mounts step on each other just because of a trailing slash.
  const normPath = (p: string) => p.trim().replace(/\/+$/, "") || "/";
  const mountPathClash = mounts.some(
    (m) => normPath(m.mountPath) === normPath(newMountPath),
  );

  const canTest = (
    (newType === "nfs" && newNfsSourceId === "external" && newNfsServer && newNfsPath) ||
    (newType === "nfs" && newNfsSourceId !== "external" && servers.some((s) => s.id === newNfsSourceId)) ||
    (newType === "s3fs" && newS3Bucket && newS3AccessKey && newS3SecretKey)
  );

  const canAdd = !!newMountPath && !mountPathClash && canTest && testStatus === "ok";

  const handleTest = async () => {
    setTestStatus("testing");
    setTestMsg("");
    setTestNodes([]);

    try {
      const res = await fetch(`/api/clusters/${clusterId}/storage/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: newType,
          nfsServer: newNfsServer,
          nfsPath: newNfsPath,
          s3Bucket: newS3Bucket,
          s3Endpoint: newS3Endpoint,
          s3AccessKey: newS3AccessKey,
          s3SecretKey: newS3SecretKey,
          s3Region: newS3Region,
        }),
      });
      const result = await res.json();
      if (Array.isArray(result.nodes)) setTestNodes(result.nodes);
      if (result.success) {
        setTestStatus("ok");
        setTestMsg(result.message ?? "Connection successful");
      } else {
        setTestStatus("failed");
        setTestMsg(result.error ?? "Test failed");
      }
    } catch {
      setTestStatus("failed");
      setTestMsg("Request failed");
    }
  };

  // Cosmetic helper for the mount table's Source column.
  const mountSourceLabel = (mount: StorageMount) => {
    if (mount.type === "nfs") {
      const linked = mount.nfsServerId ? servers.find((s) => s.id === mount.nfsServerId) : undefined;
      return (
        <div className="flex flex-col">
          <span className="font-mono">{mount.nfsServer}:{mount.nfsPath}</span>
          {linked && (
            <span className="text-[11px] text-muted-foreground">
              hosted on <span className="font-mono">{linked.hostNode}</span>
            </span>
          )}
        </div>
      );
    }
    return <span className="font-mono">s3://{mount.s3Bucket}</span>;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={fetchStatuses} disabled={checkingStatus || mounts.length === 0}>
          {checkingStatus ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
          Refresh Status
        </Button>
        <Button
          variant="outline"
          onClick={() => setCreateServerOpen(true)}
          disabled={nodes.length === 0}
          title={nodes.length === 0 ? "No nodes registered yet" : "Create a new NFS server on a cluster node"}
        >
          <Server className="mr-2 h-4 w-4" />
          Create NFS Server
        </Button>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Mount
        </Button>
      </div>

      {/* NFS Servers card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            NFS Servers ({servers.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {servers.length === 0 ? (
            <p className="text-center text-muted-foreground py-4 text-sm">
              No self-hosted NFS servers. Use <strong>Create NFS Server</strong> to provision one on a cluster node.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Host Node</TableHead>
                  <TableHead>Export Path</TableHead>
                  <TableHead>Allowed</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servers.map((server) => {
                  const node = nodes.find((n) => n.hostname === server.hostNode);
                  const busy = busyKey === `server:${server.id}`;
                  return (
                    <TableRow key={server.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-mono">{server.hostNode}</span>
                          {node && <span className="text-[11px] text-muted-foreground">{node.ip}</span>}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{server.exportPath}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {server.allowedNetwork}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={busy ? "Working..." : "Re-deploy NFS server"}
                            onClick={() => deployServer(server)}
                            disabled={busy}
                          >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive"
                            title="Remove NFS server (export)"
                            onClick={() => setConfirmRemoveServer(server)}
                            disabled={busy}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Mounts card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Storages ({mounts.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {mounts.length === 0 ? (
            <p className="text-center text-muted-foreground py-6">
              No storage mounts configured. Add an NFS or S3 mount to get started.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Mount Path</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mounts.map((mount) => {
                  const busy = busyKey === `mount:${mount.id}`;
                  return (
                    <TableRow key={mount.id}>
                      <TableCell>
                        <Badge variant="outline" className={
                          mount.type === "nfs"
                            ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                            : "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
                        }>
                          {mount.type.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        <Link
                          href={`/clusters/${clusterId}/files?root=${encodeURIComponent(mount.id)}`}
                          className="text-primary hover:underline"
                          title={`Browse files at ${mount.mountPath}`}
                        >
                          {mount.mountPath}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {mountSourceLabel(mount)}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const status = mountStatuses[mount.id] ?? {};
                          const totalTargets = targetHosts.length;
                          const mountedCount = Object.values(status).filter((s) => s === "mounted").length;
                          if (totalTargets === 0) {
                            return <span className="text-xs text-muted-foreground">—</span>;
                          }
                          if (mountedCount === totalTargets) {
                            return (
                              <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                                Active ({mountedCount}/{totalTargets})
                              </Badge>
                            );
                          }
                          if (mountedCount === 0) {
                            return (
                              <Badge variant="outline" className="text-muted-foreground">
                                Not mounted
                              </Badge>
                            );
                          }
                          return (
                            <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                              Partial ({mountedCount}/{totalTargets})
                            </Badge>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={busy ? "Working..." : "Connect mount"}
                            onClick={() => handleDeploy(mount)}
                            disabled={busy}
                          >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Fix permissions (make writable)"
                            onClick={() => {
                              setChmodMount(mount);
                              setChmodMode("0777");
                              setChmodRecursive(false);
                            }}
                            disabled={busy}
                          >
                            <LockOpen className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive"
                            title="Remove mount"
                            onClick={() => setConfirmRemoveMount(mount)}
                            disabled={busy}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create NFS Server dialog */}
      <Dialog open={createServerOpen} onOpenChange={setCreateServerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create NFS Server</DialogTitle>
            <DialogDescription>
              Installs <code className="font-mono">nfs-kernel-server</code> on the chosen node,
              creates the export directory, and adds it to <code className="font-mono">/etc/exports</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Host Node</Label>
              <Select value={newServerHost} onValueChange={setNewServerHost}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a node…" />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((n) => (
                    <SelectItem key={n.hostname} value={n.hostname}>
                      {n.hostname} ({n.ip})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Export Path</Label>
              <Input
                value={newServerExportPath}
                onChange={(e) => setNewServerExportPath(e.target.value)}
                placeholder="/srv/aura-nfs"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                The directory on the host node that gets shared. Created if missing.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Allowed Network</Label>
              <Input
                value={newServerAllowed}
                onChange={(e) => setNewServerAllowed(e.target.value)}
                placeholder="* or 10.0.0.0/24"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Written into <code className="font-mono">/etc/exports</code>. Use{" "}
                <code className="font-mono">*</code> for any host, or a CIDR to lock down.
              </p>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={handleCreateServer}
              disabled={!newServerHost || !newServerExportPath.startsWith("/")}
            >
              Create &amp; Deploy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Mount Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Storage Mount</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={newType} onValueChange={(v) => { setNewType(v as "nfs" | "s3fs"); resetTest(); }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="nfs">NFS</SelectItem>
                  <SelectItem value="s3fs">S3 (s3fs-fuse)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Mount Path</Label>
              <Input
                value={newMountPath}
                onChange={(e) => setNewMountPath(e.target.value)}
                placeholder="/mnt/shared"
                className="font-mono"
                aria-invalid={mountPathClash}
              />
              {mountPathClash && newMountPath && (
                <p className="text-xs text-destructive">
                  Another mount already uses <code className="font-mono">{normPath(newMountPath)}</code>.
                  Remove it first or choose a different path.
                </p>
              )}
            </div>

            {newType === "nfs" && (
              <>
                <div className="space-y-2">
                  <Label>Source</Label>
                  <Select
                    value={newNfsSourceId}
                    onValueChange={(v) => {
                      setNewNfsSourceId(v);
                      resetTest();
                      if (v === "external") {
                        setNewNfsServer("");
                        setNewNfsPath("");
                      } else {
                        const src = servers.find((s) => s.id === v);
                        const host = src ? nodes.find((n) => n.hostname === src.hostNode) : undefined;
                        setNewNfsServer(host?.ip ?? "");
                        setNewNfsPath(src?.exportPath ?? "");
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="external">External NFS server</SelectItem>
                      {servers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.hostNode}: {s.exportPath}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {newNfsSourceId !== "external" && (
                    <p className="text-xs text-muted-foreground">
                      Will mount on every cluster node, including the server itself,
                      so the path resolves the same everywhere.
                    </p>
                  )}
                </div>

                {newNfsSourceId === "external" && (
                  <>
                    <div className="space-y-2">
                      <Label>NFS Server</Label>
                      <Input
                        value={newNfsServer}
                        onChange={(e) => { setNewNfsServer(e.target.value); resetTest(); }}
                        placeholder="192.168.1.1 or nfs.internal"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>NFS Export Path</Label>
                      <Input
                        value={newNfsPath}
                        onChange={(e) => { setNewNfsPath(e.target.value); resetTest(); }}
                        placeholder="/export/shared"
                        className="font-mono"
                      />
                    </div>
                  </>
                )}
              </>
            )}

            {newType === "s3fs" && (
              <>
                <div className="space-y-2">
                  <Label>S3 Bucket</Label>
                  <Input
                    value={newS3Bucket}
                    onChange={(e) => { setNewS3Bucket(e.target.value); resetTest(); }}
                    placeholder="my-cluster-data"
                  />
                </div>
                <div className="space-y-2">
                  <Label>S3 Endpoint (optional, for MinIO/Ceph)</Label>
                  <Input
                    value={newS3Endpoint}
                    onChange={(e) => { setNewS3Endpoint(e.target.value); resetTest(); }}
                    placeholder="https://s3.example.com"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Access Key</Label>
                    <Input
                      value={newS3AccessKey}
                      onChange={(e) => { setNewS3AccessKey(e.target.value); resetTest(); }}
                      placeholder="AKIA..."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Secret Key</Label>
                    <Input
                      type="password"
                      value={newS3SecretKey}
                      onChange={(e) => { setNewS3SecretKey(e.target.value); resetTest(); }}
                      placeholder="secret"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Region</Label>
                  <Input
                    value={newS3Region}
                    onChange={(e) => { setNewS3Region(e.target.value); resetTest(); }}
                    placeholder="us-east-1"
                  />
                </div>
              </>
            )}
          </div>
          {(testStatus === "ok" || testStatus === "failed") && (
            <div className="space-y-2">
              {testStatus === "ok" ? (
                <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                  {testMsg}
                </Badge>
              ) : (
                <p className="text-sm text-destructive whitespace-pre-wrap">{testMsg}</p>
              )}
              {testNodes.length > 0 && (
                <div className="rounded-md border bg-muted/30 p-2 text-xs">
                  <div className="mb-1 font-medium text-muted-foreground">
                    Per-node reachability ({testNodes.filter((n) => n.ok).length}/{testNodes.length} ok)
                  </div>
                  <ul className="space-y-0.5">
                    {testNodes.map((n) => (
                      <li key={n.hostname} className="flex items-start gap-2 font-mono">
                        {n.ok ? (
                          <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                        ) : (
                          <X className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
                        )}
                        <span className="shrink-0">{n.hostname}</span>
                        <span className="text-muted-foreground">— {n.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="secondary"
              onClick={handleTest}
              disabled={!canTest || testStatus === "testing"}
            >
              {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {testStatus === "ok" && <Check className="mr-2 h-4 w-4 text-green-600" />}
              {testStatus === "failed" && <X className="mr-2 h-4 w-4 text-destructive" />}
              {testStatus === "testing" ? "Testing..." : "Test Connection"}
            </Button>
            <Button onClick={handleAdd} disabled={!canAdd}>
              Add Mount
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Realtime log dialog — used by mount + NFS-server actions */}
      <Dialog
        open={deployLogOpen}
        onOpenChange={(o) => {
          setDeployLogOpen(o);
          if (o) {
            // Re-attach the poller if the dialog is being reopened while a
            // task is still running (user closed it, then clicked the row
            // again). Avoids "frozen log" on reopen.
            if (currentTaskId && deployStatus === "running" && pollRef.current === null) {
              startPolling(currentTaskId);
            }
          } else {
            // Closing while a task is running = "let it finish in the
            // background". Stop polling so we don't hit /api/tasks every 3s
            // when nobody is watching the log; the row's busy indicator
            // stays on until reopen + poll completes.
            stopPolling();
            setCancelling(false);
          }
        }}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-8">
              {deployTitle}
              <Badge className={
                deployStatus === "running" ? "bg-blue-100 text-blue-800" :
                deployStatus === "success" ? "bg-green-100 text-green-800" :
                "bg-red-100 text-red-800"
              }>
                {deployStatus === "running" ? "Running" : deployStatus === "success" ? "Success" : "Failed"}
              </Badge>
            </DialogTitle>
          </DialogHeader>
          <div className="h-[500px] overflow-y-auto rounded-md border bg-black p-3 font-mono text-sm text-green-400">
            {deployLines.map((line, i) => (
              <div
                key={i}
                className={`whitespace-pre-wrap leading-5 ${
                  line.startsWith("[stderr]") ? "text-yellow-400" :
                  line.startsWith("[error]") ? "text-red-400" : ""
                }`}
              >
                {line || " "}
              </div>
            ))}
            {deployStatus === "running" && (
              <div className="mt-1 inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Running...
              </div>
            )}
          </div>
          <div className="flex justify-end">
            {deployStatus === "running" && currentTaskId ? (
              <Button variant="destructive" onClick={handleCancelDeploy} disabled={cancelling}>
                {cancelling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {cancelling ? "Cancelling..." : "Cancel"}
              </Button>
            ) : deployStatus !== "running" ? (
              <Button variant="outline" onClick={() => setDeployLogOpen(false)}>Close</Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {/* Remove mount confirmation */}
      <Dialog open={!!confirmRemoveMount} onOpenChange={(o) => { if (!o) setConfirmRemoveMount(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove storage mount?</DialogTitle>
            <DialogDescription>
              This will unmount <strong>{confirmRemoveMount?.mountPath}</strong> from all worker nodes,
              remove it from <code>/etc/fstab</code>, and delete the credentials file.
              The remote data ({confirmRemoveMount?.type === "nfs" ? "NFS export" : "S3 bucket"}) is not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={doRemoveMount}>
              <Trash2 className="mr-2 h-4 w-4" />
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fix Permissions dialog */}
      <Dialog open={!!chmodMount} onOpenChange={(o) => { if (!o) setChmodMount(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fix permissions on {chmodMount?.mountPath}</DialogTitle>
            <DialogDescription>
              Runs <code className="font-mono">chmod</code> on the mount from a node that has
              it mounted. Use this when writes return &ldquo;Permission denied&rdquo; — the
              mount&apos;s underlying owner is different from the SSH user.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Mode</Label>
              <Input
                value={chmodMode}
                onChange={(e) => setChmodMode(e.target.value)}
                placeholder="0777"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                <code className="font-mono">0777</code> world-writable,{" "}
                <code className="font-mono">1777</code> world-writable + sticky (only owner can delete),{" "}
                <code className="font-mono">0775</code> group-writable.
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={chmodRecursive}
                onChange={(e) => setChmodRecursive(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span>
                Recursive (<code className="font-mono">-R</code>)
                <span className="block text-xs text-muted-foreground">
                  Applies to existing files and subdirs too. Slow on large mounts.
                </span>
              </span>
            </label>
            {chmodRecursive && chmodMount?.type === "s3fs" && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                <div className="font-medium text-amber-700 dark:text-amber-400">
                  s3fs recursive chmod is slow
                </div>
                <p className="text-amber-700 dark:text-amber-400">
                  Each file triggers one S3 metadata PUT. Expect ~minutes per thousand
                  files; the task will stream a heartbeat every 5s.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={runChmod} disabled={!/^[0-7]{3,4}$/.test(chmodMode.trim())}>
              <LockOpen className="mr-2 h-4 w-4" />
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove NFS-server confirmation */}
      <Dialog open={!!confirmRemoveServer} onOpenChange={(o) => { if (!o) setConfirmRemoveServer(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove NFS server?</DialogTitle>
            <DialogDescription>
              Strips <strong>{confirmRemoveServer?.exportPath}</strong> from{" "}
              <code className="font-mono">{confirmRemoveServer?.hostNode}</code>&apos;s
              <code> /etc/exports</code> and reloads. The export directory and any data
              inside it are kept. The <code className="font-mono">nfs-kernel-server</code>{" "}
              package is also kept (other exports may rely on it).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={doRemoveServer}>
              <Trash2 className="mr-2 h-4 w-4" />
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
