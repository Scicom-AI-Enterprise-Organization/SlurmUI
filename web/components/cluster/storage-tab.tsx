"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
import { Plus, Trash2, HardDrive, Loader2, Check, X, Plug } from "lucide-react";
import { toast } from "sonner";

interface StorageMount {
  id: string;
  type: "nfs" | "s3fs";
  mountPath: string;
  // NFS fields
  nfsServer?: string;
  nfsPath?: string;
  // S3 fields
  s3Bucket?: string;
  s3Endpoint?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Region?: string;
}

interface StorageTabProps {
  clusterId: string;
  initialMounts: StorageMount[];
}

export function StorageTab({ clusterId, initialMounts }: StorageTabProps) {
  const router = useRouter();
  const [mounts, setMounts] = useState<StorageMount[]>(initialMounts);
  const [addOpen, setAddOpen] = useState(false);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [mountStatuses, setMountStatuses] = useState<Record<string, Record<string, string>>>({});
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [targetHosts, setTargetHosts] = useState<string[]>([]);
  const [deployLogOpen, setDeployLogOpen] = useState(false);
  const [deployLines, setDeployLines] = useState<string[]>([]);
  const [deployStatus, setDeployStatus] = useState<"running" | "success" | "failed">("running");

  // New mount form
  const [newType, setNewType] = useState<"nfs" | "s3fs">("nfs");
  const [newMountPath, setNewMountPath] = useState("/mnt/shared");
  const [newNfsServer, setNewNfsServer] = useState("");
  const [newNfsPath, setNewNfsPath] = useState("");
  const [newS3Bucket, setNewS3Bucket] = useState("");
  const [newS3Endpoint, setNewS3Endpoint] = useState("");
  const [newS3AccessKey, setNewS3AccessKey] = useState("");
  const [newS3SecretKey, setNewS3SecretKey] = useState("");
  const [newS3Region, setNewS3Region] = useState("us-east-1");

  // Test connection state
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "failed">("idle");
  const [testMsg, setTestMsg] = useState("");

  const resetForm = () => {
    setNewType("nfs");
    setNewMountPath("/mnt/shared");
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

  // Fetch on mount and whenever mounts change
  useEffect(() => {
    fetchStatuses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounts.length, clusterId]);

  const saveConfig = async (updatedMounts: StorageMount[]) => {
    const res = await fetch(`/api/clusters/${clusterId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { storage_mounts: updatedMounts } }),
    });
    if (!res.ok) {
      const err = await res.json();
      toast.error(err.error ?? "Failed to save");
    }
  };

  // `crypto.randomUUID` is only exposed in secure contexts (HTTPS / localhost).
  // On plain-HTTP admin deployments the browser leaves it undefined, which
  // 500'd the Add-Storage flow. Fallback builds a random-enough id without
  // needing WebCrypto.
  const genId = () => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `mnt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  };

  const handleAdd = async () => {
    const mount: StorageMount = {
      id: genId(),
      type: newType,
      mountPath: newMountPath,
      ...(newType === "nfs" ? {
        nfsServer: newNfsServer,
        nfsPath: newNfsPath,
      } : {
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
    await saveConfig(updated);
  };

  const [confirmRemove, setConfirmRemove] = useState<StorageMount | null>(null);

  const attachToTask = (taskId: string, mountId: string, action: "deploy" | "remove", removedMountId: string | null) => {
    setDeploying(mountId);
    setCurrentTaskId(taskId);
    setCancelling(false);
    setDeployLines([]);
    setDeployStatus("running");
    setDeployLogOpen(true);
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}`);
        if (!r.ok) return;
        const t = await r.json();
        setDeployLines(t.logs ? t.logs.split("\n") : []);
        if (t.status === "success") {
          setDeployStatus("success");
          clearInterval(poll);
          setDeploying(null);
          setCurrentTaskId(null);
          setCancelling(false);
          if (action === "remove" && removedMountId) {
            const updated = mounts.filter((m) => m.id !== removedMountId);
            setMounts(updated);
            await saveConfig(updated);
          }
          setTimeout(fetchStatuses, 1000);
        } else if (t.status === "failed") {
          setDeployStatus("failed");
          clearInterval(poll);
          setDeploying(null);
          setCurrentTaskId(null);
          setCancelling(false);
        }
      } catch {}
    }, 2000);
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

  const doRemove = async () => {
    const mount = confirmRemove;
    if (!mount) return;
    setConfirmRemove(null);

    const res = await fetch(`/api/clusters/${clusterId}/storage/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mount, action: "remove" }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setDeployStatus("failed");
      setDeployLines([`[error] ${err.error ?? "Failed to remove"}`]);
      setDeployLogOpen(true);
      return;
    }
    const { taskId } = await res.json();
    attachToTask(taskId, mount.id, "remove", mount.id);
  };

  const handleDeploy = async (mount: StorageMount) => {
    if (deploying === mount.id && currentTaskId) {
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
      setDeployLogOpen(true);
      return;
    }
    const { taskId } = await res.json();
    attachToTask(taskId, mount.id, "deploy", null);
  };

  const canTest = (
    (newType === "nfs" && newNfsServer && newNfsPath) ||
    (newType === "s3fs" && newS3Bucket && newS3AccessKey && newS3SecretKey)
  );

  const canAdd = newMountPath && canTest && testStatus === "ok";

  const handleTest = async () => {
    setTestStatus("testing");
    setTestMsg("");

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

  const _oldHandleTest = async () => {
    setTestStatus("testing");
    setTestMsg("");

    try {
      let cmd: string;
      if (newType === "nfs") {
        cmd = [
          `apt-get install -y -qq nfs-common 2>/dev/null || yum install -y -q nfs-utils 2>/dev/null || true`,
          `showmount -e ${newNfsServer} 2>&1 | grep -q '${newNfsPath}' && echo '__NFS_OK__' || (echo '__NFS_FAIL__' && showmount -e ${newNfsServer} 2>&1)`,
        ].join(" && ");
      } else {
        // Test S3: install s3fs, check endpoint reachability, try a quick mount
        const credLine = `${newS3AccessKey}:${newS3SecretKey}`;
        const endpointOpt = newS3Endpoint ? `-o url=${newS3Endpoint} -o use_path_request_style` : "";
        const regionOpt = newS3Region ? `-o endpoint=${newS3Region}` : "";
        cmd = `set -e
echo "=== Installing s3fs ==="
apt-get install -y -qq s3fs fuse curl 2>/dev/null || yum install -y -q s3fs-fuse fuse curl 2>/dev/null || true
which s3fs && echo "s3fs found: $(s3fs --version 2>&1 | head -1)" || { echo "__S3_FAIL__ s3fs not installed"; exit 0; }
echo "=== Checking endpoint ==="
${newS3Endpoint ? `curl -sf --max-time 10 -o /dev/null "${newS3Endpoint}" && echo "Endpoint reachable" || { echo "__S3_ENDPOINT_FAIL__ Cannot reach ${newS3Endpoint}"; exit 0; }` : 'echo "Using default AWS endpoint"'}
echo "=== Testing mount ==="
echo '${credLine}' > /tmp/.aura-s3-test && chmod 600 /tmp/.aura-s3-test
mkdir -p /tmp/.aura-s3-mount-test
S3FS_OUTPUT=$(s3fs ${newS3Bucket} /tmp/.aura-s3-mount-test -o passwd_file=/tmp/.aura-s3-test ${endpointOpt} ${regionOpt} -o allow_other -f -o dbglevel=info 2>&1 &
S3FS_PID=$!
sleep 3
if mountpoint -q /tmp/.aura-s3-mount-test 2>/dev/null; then
  echo "__S3_OK__"
  fusermount -u /tmp/.aura-s3-mount-test 2>/dev/null || true
  kill $S3FS_PID 2>/dev/null || true
else
  kill $S3FS_PID 2>/dev/null || true
  wait $S3FS_PID 2>/dev/null || true
  echo "__S3_FAIL__ $S3FS_OUTPUT"
fi)
rm -f /tmp/.aura-s3-test
rmdir /tmp/.aura-s3-mount-test 2>/dev/null || true`;
      }

      const res = await fetch(`/api/clusters/${clusterId}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });

      if (!res.ok) {
        setTestStatus("failed");
        setTestMsg("Failed to run test command");
        return;
      }

      const data = await res.json();
      const output = (data.stdout ?? "") + (data.stderr ?? "");

      if (newType === "nfs") {
        if (output.includes("__NFS_OK__")) {
          setTestStatus("ok");
          setTestMsg(`NFS export ${newNfsServer}:${newNfsPath} is accessible`);
        } else {
          setTestStatus("failed");
          const exports = output.replace("__NFS_FAIL__", "").trim();
          setTestMsg(exports ? `Export not found. Available exports:\n${exports}` : `Cannot reach NFS server ${newNfsServer}`);
        }
      } else {
        if (output.includes("__S3_OK__")) {
          setTestStatus("ok");
          setTestMsg(`S3 bucket "${newS3Bucket}" is accessible`);
        } else if (output.includes("__S3_ENDPOINT_FAIL__")) {
          setTestStatus("failed");
          const detail = output.split("__S3_ENDPOINT_FAIL__")[1]?.trim() || "";
          setTestMsg(`Cannot reach S3 endpoint: ${newS3Endpoint}${detail ? `\n${detail}` : ""}`);
        } else if (output.includes("__S3_FAIL__")) {
          setTestStatus("failed");
          const detail = output.split("__S3_FAIL__")[1]?.trim() || "";
          setTestMsg(`S3 mount failed${detail ? `:\n${detail}` : ". Check bucket name and credentials."}`);
        } else {
          setTestStatus("failed");
          setTestMsg(`Unexpected output:\n${output.slice(0, 500)}`);
        }
      }
    } catch {
      setTestStatus("failed");
      setTestMsg("Request failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={fetchStatuses} disabled={checkingStatus || mounts.length === 0}>
          {checkingStatus ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
          Refresh Status
        </Button>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Mount
        </Button>
      </div>

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
                {mounts.map((mount) => (
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
                    <TableCell className="font-mono text-sm">{mount.mountPath}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {mount.type === "nfs"
                        ? `${mount.nfsServer}:${mount.nfsPath}`
                        : `s3://${mount.s3Bucket}`}
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
                          title={deploying === mount.id ? "Mounting..." : "Connect mount"}
                          onClick={() => handleDeploy(mount)}
                          disabled={deploying === mount.id}
                        >
                          {deploying === mount.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive"
                          title="Remove mount"
                          onClick={() => setConfirmRemove(mount)}
                        >
                          <Trash2 className="h-4 w-4" />
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
              />
            </div>

            {newType === "nfs" && (
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
          {testStatus === "ok" && (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              {testMsg}
            </Badge>
          )}
          {testStatus === "failed" && (
            <p className="text-sm text-destructive whitespace-pre-wrap">{testMsg}</p>
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

      {/* Deploy Log Dialog */}
      <Dialog open={deployLogOpen} onOpenChange={setDeployLogOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-8">
              Storage Mount
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
                {line || "\u00A0"}
              </div>
            ))}
            {deployStatus === "running" && (
              <div className="mt-1 inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Running Ansible...
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

      {/* Remove mount confirmation dialog */}
      <Dialog open={!!confirmRemove} onOpenChange={(o) => { if (!o) setConfirmRemove(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove storage mount?</DialogTitle>
            <DialogDescription>
              This will unmount <strong>{confirmRemove?.mountPath}</strong> from all worker nodes,
              remove it from <code>/etc/fstab</code>, and delete the credentials file.
              The remote data ({confirmRemove?.type === "nfs" ? "NFS export" : "S3 bucket"}) is not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={doRemove}>
              <Trash2 className="mr-2 h-4 w-4" />
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
