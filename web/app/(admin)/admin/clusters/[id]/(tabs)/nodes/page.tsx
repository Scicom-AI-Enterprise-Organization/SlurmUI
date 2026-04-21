"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  DialogTrigger,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { LiveLogDialog } from "@/components/ui/live-log-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { RefreshCw, Plus, Zap, Loader2, Check, X, Wrench, Terminal as TerminalIcon, Trash2, Send, FileText, Server, Stethoscope, Pencil, ChevronDown, Layers } from "lucide-react";

interface NodeInfo {
  name: string;
  state: string;
  cpus: number;
  memory: number;
  gpus?: number;
  gres?: string;
  version?: string;
  ip?: string;
  partitions: string[];
  deployed?: boolean;
}

export default function NodesPage() {
  const params = useParams();
  const clusterId = params.id as string;

  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [clusterStatus, setClusterStatus] = useState<string>("");
  const [clusterHealth, setClusterHealth] = useState<{
    lastProbeAt?: string;
    alive?: boolean;
    message?: string;
    failStreak?: number;
  } | null>(null);

  // Activate node state
  const [activatingNode, setActivatingNode] = useState<string | null>(null);
  const [activateRequestId, setActivateRequestId] = useState<string | null>(null);
  const [activateLogOpen, setActivateLogOpen] = useState(false);

  // Add node form state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newNodeName, setNewNodeName] = useState("");
  const [newNodeIp, setNewNodeIp] = useState("");
  const [newNodeUser, setNewNodeUser] = useState("root");
  const [newNodePort, setNewNodePort] = useState(22);
  const [newNodeCpus, setNewNodeCpus] = useState(0);
  const [newNodeGpus, setNewNodeGpus] = useState(0);
  const [newNodeMemory, setNewNodeMemory] = useState(0);
  const [newNodeMemoryMb, setNewNodeMemoryMb] = useState(0);
  const [newNodeSockets, setNewNodeSockets] = useState(1);
  const [newNodeCores, setNewNodeCores] = useState(1);
  const [newNodeThreads, setNewNodeThreads] = useState(1);
  const [addingNode, setAddingNode] = useState(false);
  const [addRequestId, setAddRequestId] = useState<string | null>(null);
  const [addLogOpen, setAddLogOpen] = useState(false);

  // Edit node form state
  const [editTarget, setEditTarget] = useState<{ name: string; ip: string; sshUser: string; sshPort: number } | null>(null);
  const [editIp, setEditIp] = useState("");
  const [editSshUser, setEditSshUser] = useState("");
  const [editSshPort, setEditSshPort] = useState(22);
  const [editCpus, setEditCpus] = useState(1);
  const [editGpus, setEditGpus] = useState(0);
  const [editMemoryMb, setEditMemoryMb] = useState(1024);
  const [editSockets, setEditSockets] = useState(1);
  const [editCores, setEditCores] = useState(1);
  const [editThreads, setEditThreads] = useState(1);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editResult, setEditResult] = useState<{ ok: boolean; output: string } | null>(null);

  // SSH test state for new node
  const [nodeTestStatus, setNodeTestStatus] = useState<"idle" | "testing" | "ok" | "failed">("idle");
  const [nodeTestMsg, setNodeTestMsg] = useState("");
  const [detecting, setDetecting] = useState(false);

  const [addMenuOpen, setAddMenuOpen] = useState(false);

  // Bulk add state
  type BulkRow = {
    hostname: string;
    ip: string;
    user: string;
    port: number;
    status: "pending" | "testing" | "detecting" | "ok" | "adding" | "added" | "failed";
    msg: string;
    // Hardware detected during preview — reused at Start time so we don't
    // re-probe.
    cpus?: number;
    gpus?: number;
    memoryMb?: number;
    sockets?: number;
    coresPerSocket?: number;
    threadsPerCore?: number;
    taskId?: string;
  };
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkDefaultUser, setBulkDefaultUser] = useState("root");
  const [bulkDefaultPort, setBulkDefaultPort] = useState(22);
  const [bulkConcurrency, setBulkConcurrency] = useState(4);
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [previewRunning, setPreviewRunning] = useState(false);

  // Per-node action state
  // nodeName → taskId map for in-flight deploys. "Deploying?" is derived
  // from this — multiple nodes can deploy in parallel, each with its own
  // spinner. Clicking the spinner opens the live log for that task.
  // A sentinel "" value means "deploy starting" (no taskId yet from server).
  const [deployTasks, setDeployTasks] = useState<Record<string, string>>({});
  const isDeploying = (name: string) => name in deployTasks;
  const [deployError, setDeployError] = useState<{ nodeName: string; message: string } | null>(null);
  const [fixingNode, setFixingNode] = useState<string | null>(null);
  const [diagnosingNode, setDiagnosingNode] = useState<string | null>(null);
  const [syncingHosts, setSyncingHosts] = useState(false);
  const [deletingNode, setDeletingNode] = useState<string | null>(null);
  const [confirmDeleteNode, setConfirmDeleteNode] = useState<string | null>(null);
  const [terminalNode, setTerminalNode] = useState<string | null>(null);
  const [termLines, setTermLines] = useState<string[]>([]);
  const [termCmd, setTermCmd] = useState("");
  const [termRunning, setTermRunning] = useState(false);

  // Logs dialog state
  const [logsNode, setLogsNode] = useState<string | null>(null);
  const [logsSource, setLogsSource] = useState("slurmd");
  const [logsLines, setLogsLines] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // SSE log state (for SSH mode)
  const [sseLogLines, setSseLogLines] = useState<string[]>([]);
  const [sseLogOpen, setSseLogOpen] = useState(false);
  const [sseLogStatus, setSseLogStatus] = useState<"streaming" | "complete" | "error">("streaming");
  const [sseTaskId, setSseTaskId] = useState<string | null>(null);
  const [sseCancelling, setSseCancelling] = useState(false);
  const [sseLogTitle, setSseLogTitle] = useState("Adding new node");

  const resetNodeTest = () => {
    setNodeTestStatus("idle");
    setNodeTestMsg("");
  };

  const testNodeSsh = async () => {
    setNodeTestStatus("testing");
    setNodeTestMsg("");
    setDetecting(false);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/nodes/test-ssh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: newNodeIp, user: newNodeUser, port: newNodePort }),
      });
      const result = await res.json();
      if (res.ok && result.success) {
        setNodeTestStatus("ok");
        setNodeTestMsg(result.hostname ? `Connected to ${result.hostname}` : "Connection successful");
        // Auto-fill hostname if empty
        if (!newNodeName && result.hostname) {
          setNewNodeName(result.hostname);
        }
        // Auto-detect resources
        setDetecting(true);
        try {
          const detectRes = await fetch(`/api/clusters/${clusterId}/nodes/test-ssh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ip: newNodeIp,
              user: newNodeUser,
              port: newNodePort,
              detect: true,
            }),
          });
          const detectResult = await detectRes.json();
          if (detectRes.ok && detectResult.success) {
            if (detectResult.cpus) setNewNodeCpus(detectResult.cpus);
            if (detectResult.memoryMb) setNewNodeMemoryMb(detectResult.memoryMb);
            if (detectResult.memoryGb) setNewNodeMemory(detectResult.memoryGb);
            if (detectResult.gpus !== undefined) setNewNodeGpus(detectResult.gpus);
            if (detectResult.sockets) setNewNodeSockets(detectResult.sockets);
            if (detectResult.coresPerSocket) setNewNodeCores(detectResult.coresPerSocket);
            if (detectResult.threadsPerCore) setNewNodeThreads(detectResult.threadsPerCore);
          }
        } catch {} finally {
          setDetecting(false);
        }
      } else {
        setNodeTestStatus("failed");
        setNodeTestMsg(result.error ?? "Connection failed");
      }
    } catch {
      setNodeTestStatus("failed");
      setNodeTestMsg("Request failed");
    }
  };

  const fetchNodes = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/nodes`);
      if (res.ok) {
        const data = await res.json();
        setNodes(data.nodes ?? data ?? []);
      }
    } catch {
      // silent — manual Refresh button or next poll will recover
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // One-shot loads. No polling — nodes list and cluster status refresh
    // only on page reload or when the user clicks the Refresh button.
    fetchNodes();
    fetch(`/api/clusters/${clusterId}`)
      .then((r) => r.json())
      .then((d) => {
        setClusterStatus(d.status ?? "");
        setClusterHealth((d.config?.health as typeof clusterHealth) ?? null);
      })
      .catch(() => {});
  }, [clusterId]);

  const handleActivate = async (nodeName: string) => {
    setActivatingNode(nodeName);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/nodes/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeName }),
      });

      if (res.ok) {
        const data = await res.json();
        setActivateRequestId(data.request_id);
        setActivateLogOpen(true);
      } else {
        const err = await res.json();
        toast.error(err.error ?? "Failed to start activation");
      }
    } finally {
      setActivatingNode(null);
    }
  };

  const handleCancelAddNode = async () => {
    if (!sseTaskId) return;
    setSseCancelling(true);
    try {
      await fetch(`/api/tasks/${sseTaskId}/cancel`, { method: "POST" });
    } catch {}
    // Always clear the local "Cancelling…" spinner. The server flips the
    // task to failed synchronously, and the poll loop closes the dialog
    // on the next tick — but without this reset the button text stays
    // "Cancelling…" forever if the dialog is still open.
    setSseCancelling(false);
    // Flip the visible status right away so the user doesn't wait for
    // the next task-poll tick (up to 2s) for the dialog to update.
    setSseLogStatus("error");
    setSseTaskId(null);
  };

  const handleAddNode = async () => {
    setAddingNode(true);
    try {
      // Register only — no install. The row appears in the Nodes table with
      // state=undeployed, and a Deploy button runs the actual install.
      const res = await fetch(`/api/clusters/${clusterId}/nodes/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeName: newNodeName,
          ip: newNodeIp,
          sshUser: newNodeUser,
          sshPort: newNodePort,
          cpus: newNodeCpus,
          gpus: newNodeGpus,
          memoryMb: newNodeMemoryMb || newNodeMemory * 1024,
          sockets: newNodeSockets,
          coresPerSocket: newNodeCores,
          threadsPerCore: newNodeThreads,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        toast.error(err.error ?? "Failed to register node");
        return;
      }

      setAddDialogOpen(false);
      fetchNodes();

      setNewNodeName("");
      setNewNodeIp("");
      setNewNodeUser("root");
      setNewNodePort(22);
      setNewNodeCpus(0);
      setNewNodeGpus(0);
      setNewNodeMemory(0);
      resetNodeTest();
    } finally {
      setAddingNode(false);
    }
  };

  // Open the Edit dialog pre-filled from cluster.config (slurm_hosts_entries +
  // slurm_nodes), so admins fix a wrong IP / SSH user without re-adding the node.
  const openEditNode = async (nodeName: string) => {
    try {
      const res = await fetch(`/api/clusters/${clusterId}`);
      const c = await res.json();
      const cfg = (c.config ?? {}) as Record<string, unknown>;
      const hosts = ((cfg.slurm_hosts_entries ?? []) as Array<{ hostname: string; ip?: string }>);
      const slurmNodes = ((cfg.slurm_nodes ?? []) as Array<{
        expression?: string; name?: string; ip?: string; ssh_user?: string; ssh_port?: number;
        cpus?: number; gpus?: number; memory_mb?: number;
        sockets?: number; cores_per_socket?: number; threads_per_core?: number;
      }>);
      const h = hosts.find((x) => x.hostname === nodeName);
      const n = slurmNodes.find((x) => x.expression === nodeName || x.name === nodeName);
      const ip = h?.ip ?? n?.ip ?? "";
      const sshUser = n?.ssh_user ?? c.sshUser ?? "ubuntu";
      const sshPort = n?.ssh_port ?? c.sshPort ?? 22;
      setEditTarget({ name: nodeName, ip, sshUser, sshPort });
      setEditIp(ip);
      setEditSshUser(sshUser);
      setEditSshPort(sshPort);
      setEditCpus(n?.cpus ?? 1);
      setEditGpus(n?.gpus ?? 0);
      setEditMemoryMb(n?.memory_mb ?? 1024);
      setEditSockets(n?.sockets ?? 1);
      setEditCores(n?.cores_per_socket ?? (n?.cpus ?? 1));
      setEditThreads(n?.threads_per_core ?? 1);
      setEditResult(null);
    } catch {
      toast.error("Could not load node details");
    }
  };

  const submitEditNode = async () => {
    if (!editTarget) return;
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/nodes/${encodeURIComponent(editTarget.name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: editIp, sshUser: editSshUser, sshPort: editSshPort,
          cpus: editCpus, gpus: editGpus, memoryMb: editMemoryMb,
          sockets: editSockets, coresPerSocket: editCores, threadsPerCore: editThreads,
        }),
      });
      const d = await res.json();
      setEditResult({ ok: res.ok && d.success, output: d.output ?? d.error ?? `HTTP ${res.status}` });
      if (res.ok && d.success) await fetchNodes();
    } catch (e) {
      setEditResult({ ok: false, output: e instanceof Error ? e.message : "Network error" });
    } finally {
      setSavingEdit(false);
    }
  };

  // Deploy a registered-but-undeployed node. Runs silently in the
  // background — the only UI is the spinner on the Deploy icon. User clicks
  // the spinning icon to pop open the live log dialog via reopenDeployLog.
  const handleDeployNode = async (nodeName: string) => {
    // Mark this node as deploying immediately (sentinel empty taskId) so its
    // spinner appears even before the /nodes/add response comes back.
    setDeployTasks((prev) => ({ ...prev, [nodeName]: "" }));
    const clearDeploy = () => setDeployTasks((prev) => {
      const next = { ...prev };
      delete next[nodeName];
      return next;
    });
    try {
      const cRes = await fetch(`/api/clusters/${clusterId}`);
      const c = await cRes.json();
      const cfg = (c.config ?? {}) as Record<string, unknown>;
      const slurmNodes = ((cfg.slurm_nodes ?? []) as Array<Record<string, any>>);
      const hostsEntries = ((cfg.slurm_hosts_entries ?? []) as Array<Record<string, any>>);
      const n = slurmNodes.find((x) => x.expression === nodeName || x.name === nodeName) || {};
      const h = hostsEntries.find((x) => x.hostname === nodeName) || {};

      // Merge slurm_hosts_entries as a fallback — older Add-Node runs only
      // populated that entry for ip/user/port, leaving slurm_nodes thin.
      const ip = (n.ip as string) || (h.ip as string) || "";
      const sshUser = (n.ssh_user as string) || (h.user as string) || "root";
      const sshPort = (n.ssh_port as number) || (h.port as number) || 22;
      const cpus = (n.cpus as number) || 0;
      const memoryMb = (n.memory_mb as number) || 0;
      if (!ip || !cpus || !memoryMb) {
        setDeployError({
          nodeName,
          message:
            `Missing required fields for ${nodeName}:` +
            `\n  ip        = ${ip || "<missing>"}` +
            `\n  cpus      = ${cpus || "<missing>"}` +
            `\n  memoryMb  = ${memoryMb || "<missing>"}` +
            `\n\nOpen Edit on this row and fill in CPUs / Memory (and IP if blank), then click Deploy again.`,
        });
        clearDeploy();
        return;
      }

      const res = await fetch(`/api/clusters/${clusterId}/nodes/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeName,
          ip,
          sshUser,
          sshPort,
          cpus,
          gpus: (n.gpus as number) || 0,
          memoryMb,
          sockets: (n.sockets as number) || 1,
          coresPerSocket: (n.cores_per_socket as number) || cpus || 1,
          threadsPerCore: (n.threads_per_core as number) || 1,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setDeployError({ nodeName, message: err.error ?? `HTTP ${res.status}` });
        clearDeploy();
        return;
      }
      const data = await res.json();
      if (!data.taskId) {
        clearDeploy();
        fetchNodes();
        return;
      }
      setDeployTasks((prev) => ({ ...prev, [nodeName]: data.taskId }));
      const poll = setInterval(async () => {
        try {
          const tRes = await fetch(`/api/tasks/${data.taskId}`);
          if (!tRes.ok) return;
          const t = await tRes.json();
          if (t.status === "success" || t.status === "failed") {
            clearInterval(poll);
            // Don't pop a secondary dialog on failure — the deploy log
            // dialog itself already shows the final state. The user can
            // close it or click the ⚡ spinner later to re-open the log.
            clearDeploy();
            fetchNodes();
          }
        } catch {}
      }, 2000);
    } catch (e) {
      setDeployError({ nodeName, message: e instanceof Error ? e.message : "Error" });
      clearDeploy();
    }
  };

  // Re-open the streaming log dialog for an in-flight deploy, without
  // starting a new install. Used when the user closes the dialog and wants
  // to check progress again by clicking the spinning Deploy icon.
  const reopenDeployLog = async (nodeName: string) => {
    const taskId = deployTasks[nodeName];
    if (!taskId) {
      // Sentinel "" — deploy just started, no taskId from server yet.
      toast.info(`Waiting for ${nodeName}'s deploy to start…`);
      return;
    }
    setSseLogTitle(`Deploying node: ${nodeName}`);
    setSseLogLines([]);
    setSseLogStatus("streaming");
    setSseTaskId(taskId);
    setSseLogOpen(true);
    // Poll every 2s — mirrors handleFixNode / handleDiagnoseNode. The
    // one-shot fetch we used to do here left the dialog frozen on the
    // snapshot from when the user clicked the ⚡ spinner, even though the
    // task kept streaming logs into the DB.
    const poll = setInterval(async () => {
      try {
        const taskRes = await fetch(`/api/tasks/${taskId}`);
        if (!taskRes.ok) return;
        const t = await taskRes.json();
        setSseLogLines(t.logs ? t.logs.split("\n") : []);
        if (t.status === "success") { setSseLogStatus("complete"); clearInterval(poll); }
        else if (t.status === "failed") { setSseLogStatus("error"); clearInterval(poll); }
      } catch {}
    }, 2000);
  };

  const handleFixNode = async (nodeName: string) => {
    setFixingNode(nodeName);
    setSseLogTitle(`Fixing node: ${nodeName}`);
    setSseLogLines([]);
    setSseLogStatus("streaming");
    setSseLogOpen(true);

    try {
      const res = await fetch(`/api/clusters/${clusterId}/nodes/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSseLogLines((prev) => [...prev, `[error] ${err.error ?? `Server returned ${res.status}`}`]);
        setSseLogStatus("error");
        setFixingNode(null);
        return;
      }
      const { taskId } = await res.json();
      const poll = setInterval(async () => {
        try {
          const taskRes = await fetch(`/api/tasks/${taskId}`);
          if (!taskRes.ok) return;
          const task = await taskRes.json();
          setSseLogLines(task.logs ? task.logs.split("\n") : []);
          if (task.status === "success") {
            setSseLogStatus("complete");
            clearInterval(poll);
            setFixingNode(null);
            fetchNodes();
          } else if (task.status === "failed") {
            setSseLogStatus("error");
            clearInterval(poll);
            setFixingNode(null);
            fetchNodes();
          }
        } catch {}
      }, 2000);
      return;
    } catch (err) {
      setSseLogLines((prev) => [...prev, `[error] ${err instanceof Error ? err.message : "Request failed"}`]);
      setSseLogStatus("error");
      setFixingNode(null);
    }
  };

  const handleSyncHosts = async () => {
    setSyncingHosts(true);
    setSseLogTitle("Syncing /etc/hosts");
    setSseLogLines([]);
    setSseLogStatus("streaming");
    setSseLogOpen(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/nodes/sync-hosts`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSseLogLines((prev) => [...prev, `[error] ${err.error ?? `Server returned ${res.status}`}`]);
        setSseLogStatus("error");
        setSyncingHosts(false);
        return;
      }
      const { taskId } = await res.json();
      const poll = setInterval(async () => {
        try {
          const taskRes = await fetch(`/api/tasks/${taskId}`);
          if (!taskRes.ok) return;
          const task = await taskRes.json();
          setSseLogLines(task.logs ? task.logs.split("\n") : []);
          if (task.status === "success") {
            setSseLogStatus("complete");
            clearInterval(poll);
            setSyncingHosts(false);
          } else if (task.status === "failed") {
            setSseLogStatus("error");
            clearInterval(poll);
            setSyncingHosts(false);
          }
        } catch {}
      }, 2000);
    } catch (err) {
      setSseLogLines((prev) => [...prev, `[error] ${err instanceof Error ? err.message : "Request failed"}`]);
      setSseLogStatus("error");
      setSyncingHosts(false);
    }
  };

  const handleDiagnoseNode = async (nodeName: string) => {
    setDiagnosingNode(nodeName);
    setSseLogTitle(`Diagnosing node: ${nodeName}`);
    setSseLogLines([]);
    setSseLogStatus("streaming");
    setSseLogOpen(true);

    try {
      const res = await fetch(`/api/clusters/${clusterId}/nodes/diagnose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSseLogLines((prev) => [...prev, `[error] ${err.error ?? `Server returned ${res.status}`}`]);
        setSseLogStatus("error");
        setDiagnosingNode(null);
        return;
      }
      const { taskId } = await res.json();
      const poll = setInterval(async () => {
        try {
          const taskRes = await fetch(`/api/tasks/${taskId}`);
          if (!taskRes.ok) return;
          const task = await taskRes.json();
          setSseLogLines(task.logs ? task.logs.split("\n") : []);
          if (task.status === "success") {
            setSseLogStatus("complete");
            clearInterval(poll);
            setDiagnosingNode(null);
          } else if (task.status === "failed") {
            setSseLogStatus("error");
            clearInterval(poll);
            setDiagnosingNode(null);
          }
        } catch {}
      }, 2000);
    } catch (err) {
      setSseLogLines((prev) => [...prev, `[error] ${err instanceof Error ? err.message : "Request failed"}`]);
      setSseLogStatus("error");
      setDiagnosingNode(null);
    }
  };

  const confirmDelete = async () => {
    const nodeName = confirmDeleteNode;
    if (!nodeName) return;
    setConfirmDeleteNode(null);
    await doDeleteNode(nodeName);
  };

  const doDeleteNode = async (nodeName: string) => {
    setDeletingNode(nodeName);
    setSseLogTitle(`Deleting node: ${nodeName}`);
    setSseLogLines([`[aura] Deleting node: ${nodeName}`, ""]);
    setSseLogStatus("streaming");
    setSseLogOpen(true);

    try {
      // Call the dedicated delete API which cleans up both slurm.conf and DB config
      const res = await fetch(`/api/clusters/${clusterId}/nodes/${encodeURIComponent(nodeName)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (res.ok) {
        for (const line of (data.output || "").split("\n")) {
          if (line.trim()) setSseLogLines((prev) => [...prev, line]);
        }
        setSseLogLines((prev) => [...prev, "", "[aura] Node deleted successfully."]);
        setSseLogStatus("complete");
        setTimeout(fetchNodes, 1000);
      } else {
        setSseLogLines((prev) => [...prev, `[error] ${data.error ?? "Failed"}`]);
        setSseLogStatus("error");
      }
    } catch (err) {
      setSseLogLines((prev) => [...prev, `[error] ${err instanceof Error ? err.message : "Request failed"}`]);
      setSseLogStatus("error");
    } finally {
      setDeletingNode(null);
    }
  };

  const openNodeTerminal = (nodeName: string) => {
    setTerminalNode(nodeName);
    setTermLines([`Connected to ${nodeName} via controller`, ""]);
  };

  const runNodeCommand = async () => {
    const cmd = termCmd.trim();
    if (!cmd || !terminalNode || termRunning) return;
    setTermCmd("");
    setTermLines((prev) => [...prev, `$ ${cmd}`]);
    setTermRunning(true);
    try {
      // Just run the command directly on the controller (which is often the node too).
      // The /exec endpoint handles bastion marker extraction internally.
      const res = await fetch(`/api/clusters/${clusterId}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json();
      const output = (data.stdout ?? "").replace(/\r/g, "").trim();
      if (output) {
        for (const l of output.split("\n")) {
          const trimmed = l.trim();
          // Filter bastion welcome banner noise
          if (trimmed && !trimmed.startsWith("Welcome to") &&
              !trimmed.includes("System load:") && !trimmed.includes("Usage of /:") &&
              !trimmed.includes("Memory usage:") && !trimmed.includes("Swap usage:") &&
              !trimmed.includes("Last login:") && !trimmed.includes("System information as of") &&
              !trimmed.includes("Processes:") && !trimmed.includes("Users logged in:") &&
              !trimmed.includes("IPv4 address") && !trimmed.includes("Connection to") &&
              !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/)) {
            setTermLines((p) => [...p, l]);
          }
        }
      }
      if (!data.success && data.exitCode !== null && data.exitCode !== 0) {
        setTermLines((p) => [...p, `[exit ${data.exitCode}]`]);
      }
      if (data.stderr) {
        for (const l of data.stderr.split("\n")) {
          if (l && !l.includes("Permanently added") && !l.includes("Connection to")) {
            setTermLines((p) => [...p, `[stderr] ${l}`]);
          }
        }
      }
    } catch {
      setTermLines((p) => [...p, "[error] Request failed"]);
    } finally {
      setTermRunning(false);
    }
  };

  const fetchNodeLogs = async (nodeName: string, source: string) => {
    setLogsLoading(true);
    setLogsLines([]);
    try {
      // Look up the node's IP + SSH details so we can hop from the controller
      // into the worker and fetch ITS journal, not the controller's.
      const nodeEntry = nodes.find((n) => n.name === nodeName);
      const ip = nodeEntry?.ip;
      const remoteCmd = source === "system"
        ? "sudo dmesg --time-format iso | tail -100"
        : `sudo journalctl -u ${source} --no-pager -n 100 --output short-iso 2>/dev/null || echo 'Service ${source} not found'`;
      // If we know the node IP and it's not the controller itself, wrap in
      // ssh -n so we fetch from the right box. Fall back to running locally
      // on the controller when we don't know the IP (e.g. stub entries).
      const cmd = ip
        ? `ssh -n -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 ${ip} '${remoteCmd}'`
        : remoteCmd;
      const res = await fetch(`/api/clusters/${clusterId}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json();
      const output = (data.stdout || "").replace(/\r/g, "").trim();
      if (output) {
        // Filter bastion welcome banner noise
        const filtered = output.split("\n").filter((l: string) => {
          const t = l.trim();
          return t && !t.startsWith("Welcome to") &&
            !t.includes("System load:") && !t.includes("Usage of /:") &&
            !t.includes("Memory usage:") && !t.includes("Swap usage:") &&
            !t.includes("Last login:") && !t.includes("System information as of") &&
            !t.includes("Processes:") && !t.includes("Users logged in:") &&
            !t.includes("IPv4 address") && !t.includes("Connection to") &&
            !t.match(/^[a-z]+@[^:]+:[~\/].*\$/);
        });
        setLogsLines(filtered.length > 0 ? filtered : ["(no logs found)"]);
      } else {
        setLogsLines(["(no logs found)"]);
      }
    } catch {
      setLogsLines(["[error] Request failed"]);
    } finally {
      setLogsLoading(false);
    }
  };

  const openNodeLogs = (nodeName: string) => {
    setLogsNode(nodeName);
    setLogsSource("slurmd");
    fetchNodeLogs(nodeName, "slurmd");
  };

  // Parse the bulk textarea into rows. Accepts:
  //   ip                              (hostname auto-detected)
  //   hostname  ip
  //   hostname,ip
  //   hostname,ip,user,port
  // Blank lines and lines starting with # are ignored.
  const isIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":");
  const parseBulk = (text: string, defUser: string, defPort: number): BulkRow[] => {
    const rows: BulkRow[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.includes(",") ? line.split(",").map((s) => s.trim()) : line.split(/\s+/);
      let hostname = "";
      let ip = "";
      let user: string | undefined;
      let port: string | undefined;
      if (parts.length === 1) {
        // Single token — must be an IP; hostname gets detected via SSH.
        ip = parts[0];
      } else {
        [hostname, ip, user, port] = parts;
        // If user put "ip hostname" instead of "hostname ip", swap.
        if (!isIp(ip) && isIp(hostname)) [hostname, ip] = [ip, hostname];
      }
      if (!ip) continue;
      rows.push({
        hostname,
        ip,
        user: user || defUser,
        port: port ? parseInt(port, 10) || defPort : defPort,
        status: "pending",
        msg: "",
      });
    }
    return rows;
  };

  // Preview validates each row: SSH-tests, auto-detects hostname when missing,
  // and probes hardware. A row is "ok" only after both calls succeed. Start is
  // gated on every row being "ok" so you can't launch a bulk add against nodes
  // that didn't pass validation.
  const previewBulk = async () => {
    const parsed = parseBulk(bulkText, bulkDefaultUser, bulkDefaultPort);
    if (parsed.length === 0) {
      toast.error("No valid rows to preview");
      setBulkRows([]);
      return;
    }
    setBulkRows(parsed);
    setPreviewRunning(true);
    try {
      const queue = parsed.map((_, i) => i);
      const conc = Math.max(1, Math.min(bulkConcurrency, queue.length));
      const workers = Array.from({ length: conc }, async () => {
        while (queue.length > 0) {
          const idx = queue.shift();
          if (idx === undefined) return;
          const r = parsed[idx];
          try {
            patchRow(idx, { status: "testing", msg: "Testing SSH…" });
            const testRes = await fetch(`/api/clusters/${clusterId}/nodes/test-ssh`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ip: r.ip, user: r.user, port: r.port }),
            });
            const testData = await testRes.json();
            if (!testRes.ok || !testData.success) {
              patchRow(idx, { status: "failed", msg: testData.error || "SSH test failed" });
              continue;
            }
            if (!r.hostname) {
              const detected = (testData.hostname || "").trim();
              if (!detected) {
                patchRow(idx, { status: "failed", msg: "Hostname not detected from SSH" });
                continue;
              }
              r.hostname = detected;
              patchRow(idx, { hostname: detected });
            }

            patchRow(idx, { status: "detecting", msg: "Detecting hardware…" });
            const detRes = await fetch(`/api/clusters/${clusterId}/nodes/test-ssh`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ip: r.ip, user: r.user, port: r.port, detect: true }),
            });
            const det = await detRes.json();
            if (!detRes.ok || !det.success) {
              patchRow(idx, { status: "failed", msg: det.error || "Hardware detection failed" });
              continue;
            }

            const memMb = det.memoryMb || (det.memoryGb ? det.memoryGb * 1024 : 0);
            const patch: Partial<BulkRow> = {
              status: "ok",
              msg: `${det.cpus ?? "?"} CPU · ${det.gpus ?? 0} GPU · ${memMb ? Math.round(memMb / 1024) + " GB" : "?"}`,
              cpus: det.cpus || 0,
              gpus: det.gpus || 0,
              memoryMb: memMb,
              sockets: det.sockets || 1,
              coresPerSocket: det.coresPerSocket || det.cpus || 1,
              threadsPerCore: det.threadsPerCore || 1,
            };
            // Mutate the parsed row too so Start can use these values directly.
            Object.assign(r, patch);
            patchRow(idx, patch);
          } catch (e) {
            patchRow(idx, { status: "failed", msg: e instanceof Error ? e.message : "Error" });
          }
        }
      });
      await Promise.all(workers);
    } finally {
      setPreviewRunning(false);
    }
  };

  // Update a single row in place without wiping progress on others. We keep the
  // row array stable-by-index so the status table doesn't jump around.
  const patchRow = (idx: number, patch: Partial<BulkRow>) => {
    setBulkRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  // Bulk "Start" worker. Registers one row. Returns true if the row ended
  // up in `added` state so the caller can build the deploy batch without
  // waiting for React's async state flush.
  const addOneBulk = async (idx: number, row: BulkRow): Promise<boolean> => {
    try {
      patchRow(idx, { status: "adding", msg: "Registering…" });
      const res = await fetch(`/api/clusters/${clusterId}/nodes/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeName: row.hostname,
          ip: row.ip,
          sshUser: row.user,
          sshPort: row.port,
          cpus: row.cpus || 0,
          gpus: row.gpus || 0,
          memoryMb: row.memoryMb || 0,
          sockets: row.sockets || 1,
          coresPerSocket: row.coresPerSocket || row.cpus || 1,
          threadsPerCore: row.threadsPerCore || 1,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        patchRow(idx, { status: "failed", msg: data.error || `HTTP ${res.status}` });
        return false;
      }
      patchRow(idx, { status: "added", msg: "Registered — deploying…" });
      return true;
    } catch (e) {
      patchRow(idx, { status: "failed", msg: e instanceof Error ? e.message : "Error" });
      return false;
    }
  };

  // Deploy a single registered node and resolve when the task completes.
  // Used by runBulk to parallelize deploys and wait for all before closing.
  const deployAndWait = async (row: BulkRow): Promise<boolean> => {
    setDeployTasks((prev) => ({ ...prev, [row.hostname]: "" }));
    const clearDeploy = () => setDeployTasks((prev) => {
      const next = { ...prev };
      delete next[row.hostname];
      return next;
    });
    try {
      const addRes = await fetch(`/api/clusters/${clusterId}/nodes/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeName: row.hostname,
          ip: row.ip,
          sshUser: row.user,
          sshPort: row.port,
          cpus: row.cpus || 1,
          gpus: row.gpus || 0,
          memoryMb: row.memoryMb || 1024,
          sockets: row.sockets || 1,
          coresPerSocket: row.coresPerSocket || row.cpus || 1,
          threadsPerCore: row.threadsPerCore || 1,
        }),
      });
      if (!addRes.ok) {
        clearDeploy();
        return false;
      }
      const data = await addRes.json();
      if (!data.taskId) {
        clearDeploy();
        return true;
      }
      setDeployTasks((prev) => ({ ...prev, [row.hostname]: data.taskId }));
      // Poll until terminal.
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const tRes = await fetch(`/api/tasks/${data.taskId}`);
          if (!tRes.ok) continue;
          const t = await tRes.json();
          if (t.status === "success" || t.status === "failed") {
            clearDeploy();
            return t.status === "success";
          }
        } catch {}
      }
    } catch {
      clearDeploy();
      return false;
    }
  };

  const runBulk = async () => {
    if (bulkRows.length === 0 || bulkRows.some((r) => r.status !== "ok")) {
      toast.error("Preview all rows and ensure every row is OK before starting");
      return;
    }
    const rows = bulkRows;
    setBulkRunning(true);
    try {
      // Phase 1: register each row sequentially (cluster.config writes race
      // under parallel POSTs). Collect successfully-registered rows into
      // toDeploy directly — don't rely on React state, which won't be
      // flushed in time when we read bulkRows.
      const toDeploy: BulkRow[] = [];
      for (let i = 0; i < rows.length; i++) {
        const ok = await addOneBulk(i, rows[i]);
        if (ok) toDeploy.push(rows[i]);
      }

      // Phase 2: fire deploys in the BACKGROUND (no await) and pre-populate
      // deployTasks so the ⚡ spinners on the main nodes table appear the
      // instant the dialog closes. Each deploy polls independently and
      // clears its own spinner.
      if (toDeploy.length > 0) {
        setDeployTasks((prev) => {
          const next = { ...prev };
          for (const r of toDeploy) next[r.hostname] = "";
          return next;
        });
        for (const r of toDeploy) { void deployAndWait(r); }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk add crashed");
    } finally {
      setBulkRunning(false);
      fetchNodes();
      setBulkRows([]);
      setBulkText("");
      setBulkOpen(false);
    }
  };

  // Open the same live-log dialog used by single add, but point it at a bulk
  // row's taskId. Polls until terminal status, then freezes the dialog so the
  // user can still scroll the final log.
  const openBulkRowLogs = (row: BulkRow) => {
    if (!row.taskId) {
      toast.info("No task logs yet — row hasn't started adding");
      return;
    }
    const taskId = row.taskId;
    setSseLogTitle(`Adding ${row.hostname || row.ip}`);
    setSseLogLines([]);
    setSseLogStatus("streaming");
    setSseTaskId(null); // no cancel button for historical rows
    setSseLogOpen(true);
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`);
        if (!res.ok) return;
        const t = await res.json();
        setSseLogLines(t.logs ? t.logs.split("\n") : []);
        if (t.status === "success") {
          clearInterval(poll);
          setSseLogStatus("complete");
        } else if (t.status === "failed") {
          clearInterval(poll);
          setSseLogStatus("error");
        }
      } catch {}
    }, 1500);
  };

  const bulkStatusColor = (s: BulkRow["status"]) => {
    switch (s) {
      case "ok": return "bg-emerald-100 text-emerald-800";
      case "added": return "bg-green-100 text-green-800";
      case "failed": return "bg-red-100 text-red-800";
      case "pending": return "bg-gray-100 text-gray-700";
      default: return "bg-blue-100 text-blue-800";
    }
  };

  const stateColor = (state: string) => {
    const s = state.toLowerCase();
    if (s.includes("idle")) return "bg-green-100 text-green-800";
    if (s.includes("alloc") || s.includes("mix")) return "bg-blue-100 text-blue-800";
    if (s.includes("down") || s.includes("drain")) return "bg-red-100 text-red-800";
    if (s === "undeployed") return "bg-amber-100 text-amber-800";
    return "bg-gray-100 text-gray-800";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchNodes} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="outline" onClick={handleSyncHosts} disabled={syncingHosts}>
            {syncingHosts ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Server className="mr-2 h-4 w-4" />}
            Sync /etc/hosts
          </Button>
          <div className="relative">
            <Button
              disabled={clusterStatus === "PROVISIONING"}
              title={clusterStatus === "PROVISIONING" ? "Bootstrap is still in progress" : undefined}
              onClick={() => setAddMenuOpen((v) => !v)}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Node
              <ChevronDown className="ml-2 h-4 w-4" />
            </Button>
            {addMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setAddMenuOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border bg-popover p-1 shadow-md">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                    onClick={() => { setAddMenuOpen(false); setAddDialogOpen(true); }}
                  >
                    <Plus className="h-4 w-4" />
                    Add one node
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                    onClick={() => { setAddMenuOpen(false); setBulkOpen(true); }}
                  >
                    <Layers className="h-4 w-4" />
                    Bulk add…
                  </button>
                </div>
              </>
            )}
          </div>
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Node</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>IP Address</Label>
                  <Input
                    value={newNodeIp}
                    onChange={(e) => { setNewNodeIp(e.target.value); resetNodeTest(); }}
                    placeholder="10.15.14.84"
                  />
                  <p className="text-xs text-muted-foreground">Internal IP reachable from the controller</p>
                </div>
                <div className="grid grid-cols-[1fr_1fr_auto] gap-4 items-end">
                  <div className="space-y-2">
                    <Label>SSH User</Label>
                    <Input
                      value={newNodeUser}
                      onChange={(e) => { setNewNodeUser(e.target.value); resetNodeTest(); }}
                      placeholder="root"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>SSH Port</Label>
                    <Input
                      type="number"
                      value={newNodePort}
                      onChange={(e) => { setNewNodePort(parseInt(e.target.value) || 22); resetNodeTest(); }}
                    />
                  </div>
                  <Button
                    variant={nodeTestStatus === "ok" ? "outline" : "secondary"}
                    disabled={!newNodeIp || nodeTestStatus === "testing" || detecting}
                    onClick={testNodeSsh}
                  >
                    {(nodeTestStatus === "testing" || detecting) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {nodeTestStatus === "ok" && !detecting && <Check className="mr-2 h-4 w-4 text-green-600" />}
                    {nodeTestStatus === "failed" && <X className="mr-2 h-4 w-4 text-destructive" />}
                    {nodeTestStatus === "testing" ? "Connecting..." : detecting ? "Detecting..." : "Test SSH"}
                  </Button>
                </div>
                {nodeTestStatus === "ok" && (
                  <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    {nodeTestMsg}
                  </Badge>
                )}
                {nodeTestStatus === "failed" && (
                  <p className="text-sm text-destructive">{nodeTestMsg}</p>
                )}
                {nodeTestStatus === "ok" && (
                  <>
                    <div className="space-y-2">
                      <Label>Slurm Hostname</Label>
                      <Input
                        value={newNodeName}
                        onChange={(e) => setNewNodeName(e.target.value)}
                        placeholder="slm-node-11"
                      />
                      {nodes.some((n) => n.name === newNodeName) ? (
                        <p className="text-xs text-destructive">A node with this name already exists. Delete it first or choose a different name.</p>
                      ) : (
                        <p className="text-xs text-muted-foreground">Node name in slurm.conf. Auto-filled from hostname.</p>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <Label>CPUs</Label>
                        <Input
                          type="number"
                          value={newNodeCpus}
                          onChange={(e) => setNewNodeCpus(parseInt(e.target.value) || 0)}
                        />
                        <p className="text-xs text-muted-foreground">Auto-detected</p>
                      </div>
                      <div className="space-y-2">
                        <Label>GPUs</Label>
                        <Input
                          type="number"
                          value={newNodeGpus}
                          onChange={(e) => setNewNodeGpus(parseInt(e.target.value) || 0)}
                        />
                        <p className="text-xs text-muted-foreground">Auto-detected</p>
                      </div>
                      <div className="space-y-2">
                        <Label>Memory (GB)</Label>
                        <Input
                          type="number"
                          value={newNodeMemory}
                          onChange={(e) => setNewNodeMemory(parseInt(e.target.value) || 0)}
                        />
                        <p className="text-xs text-muted-foreground">Auto-detected</p>
                      </div>
                    </div>
                    <Button
                      onClick={handleAddNode}
                      disabled={addingNode || detecting || !newNodeName || !newNodeIp || nodes.some((n) => n.name === newNodeName)}
                      className="w-full"
                    >
                      {addingNode ? "Adding..." : "Add Node"}
                    </Button>
                  </>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {clusterStatus === "PROVISIONING" && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          Cluster must be bootstrapped before adding nodes. Click the <strong>Bootstrap</strong> button above to set up the controller first.
        </div>
      )}
      {clusterStatus === "OFFLINE" && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-400 space-y-1">
          <div className="font-medium">Controller is unreachable over SSH right now.</div>
          <div className="text-xs">
            Adding nodes will still write config, but deploys will fail until the controller is back online.
          </div>
          {clusterHealth?.lastProbeAt && (
            <div className="mt-2 space-y-0.5 rounded-md border border-red-500/20 bg-red-500/10 p-2 font-mono text-[11px]">
              <div>last probe: {new Date(clusterHealth.lastProbeAt).toLocaleString()}</div>
              <div>result:     {clusterHealth.alive ? "alive" : "failed"}</div>
              {clusterHealth.message && <div>message:    {clusterHealth.message}</div>}
              {typeof clusterHealth.failStreak === "number" && clusterHealth.failStreak > 0 && (
                <div>fail streak: {clusterHealth.failStreak}</div>
              )}
            </div>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Nodes ({nodes.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-center text-muted-foreground">Loading nodes...</p>
          ) : nodes.length === 0 ? (
            <p className="text-center text-muted-foreground">No nodes found</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>CPUs</TableHead>
                  <TableHead>Memory</TableHead>
                  <TableHead>GPUs</TableHead>
                  <TableHead>Slurm</TableHead>
                  <TableHead>Partitions</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nodes.map((node) => (
                  <TableRow key={node.name}>
                    <TableCell className="font-medium">{node.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={stateColor(node.state)}>
                        {node.state}
                      </Badge>
                    </TableCell>
                    <TableCell>{node.cpus}</TableCell>
                    <TableCell>{node.memory >= 1024 ? Math.round(node.memory / 1024) : node.memory} GB</TableCell>
                    <TableCell>{(() => {
                      const g = (node as any).gres ?? "";
                      const match = g.match(/gpu:(\d+)/);
                      return match ? match[1] : ((node as any).gpus ?? 0);
                    })()}</TableCell>
                    <TableCell>{(() => {
                      const v = node.version ?? "";
                      // Highlight mismatch: if any node's version differs from
                      // the first one's, row gets a warning color — fastest way
                      // to spot the controller/worker drift that causes the
                      // "Header lengths are longer than data received" error.
                      const ref = nodes[0]?.version ?? "";
                      const mismatch = v && ref && v !== ref;
                      return v ? (
                        <span className={`font-mono text-xs ${mismatch ? "text-destructive font-semibold" : ""}`}
                          title={mismatch ? `Differs from ${nodes[0]?.name}: ${ref}` : undefined}>
                          {v}
                        </span>
                      ) : <span className="text-xs text-muted-foreground">—</span>;
                    })()}</TableCell>
                    <TableCell>{node.partitions?.join(", ") ?? "-"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className={node.deployed === false ? "text-amber-700 dark:text-amber-400" : ""}
                          title={
                            isDeploying(node.name)
                              ? "Deploying — click to view log"
                              : node.deployed === false
                                ? "Deploy (install slurmd + slurm-client)"
                                : "Redeploy (re-run install, picks up new packages / config)"
                          }
                          onClick={() => isDeploying(node.name)
                            ? reopenDeployLog(node.name)
                            : handleDeployNode(node.name)}
                        >
                          {isDeploying(node.name)
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Zap className="h-4 w-4" />}
                        </Button>
                        {node.state.toLowerCase().includes("future") && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={activatingNode === node.name ? "Activating..." : "Activate"}
                            onClick={() => handleActivate(node.name)}
                            disabled={activatingNode === node.name}
                          >
                            {activatingNode === node.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                          </Button>
                        )}
                        {(() => {
                          const s = node.state.toLowerCase();
                          // Show Fix for anything that isn't a clean idle/alloc/future state —
                          // covers drain, down, invalid, completing (CG), mixed stuck, etc.
                          const canFix = !s.includes("future") && !(s === "idle" || s === "allocated" || s === "alloc");
                          if (!canFix) return null;
                          return (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="Fix node state (restarts slurmd, DOWN → RESUME)"
                              onClick={() => handleFixNode(node.name)}
                              disabled={fixingNode === node.name}
                            >
                              {fixingNode === node.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
                            </Button>
                          );
                        })()}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Diagnose (ping, slurmd status, chrony, recent logs — read-only)"
                          onClick={() => handleDiagnoseNode(node.name)}
                          disabled={diagnosingNode === node.name}
                        >
                          {diagnosingNode === node.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Edit IP / SSH user / port"
                          onClick={() => openEditNode(node.name)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Terminal"
                          onClick={() => openNodeTerminal(node.name)}
                        >
                          <TerminalIcon className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Logs"
                          onClick={() => openNodeLogs(node.name)}
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive"
                          title="Delete node"
                          onClick={() => setConfirmDeleteNode(node.name)}
                          disabled={deletingNode === node.name}
                        >
                          {deletingNode === node.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
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

      {/* Live log dialogs for async operations */}
      <LiveLogDialog
        open={activateLogOpen}
        onOpenChange={setActivateLogOpen}
        title={`Activating node: ${activatingNode ?? ""}`}
        clusterId={clusterId}
        requestId={activateRequestId}
        onSuccess={() => { toast.success("Node activated successfully"); fetchNodes(); }}
      />

      <LiveLogDialog
        open={addLogOpen}
        onOpenChange={setAddLogOpen}
        title="Adding new node"
        clusterId={clusterId}
        requestId={addRequestId}
        onSuccess={() => { toast.success("Node added successfully"); fetchNodes(); }}
      />

      {/* SSH mode log dialog */}
      <Dialog open={sseLogOpen} onOpenChange={setSseLogOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-8">
              {sseLogTitle}
              <Badge className={
                sseLogStatus === "streaming" ? "bg-blue-100 text-blue-800" :
                sseLogStatus === "complete" ? "bg-green-100 text-green-800" :
                "bg-red-100 text-red-800"
              }>
                {sseLogStatus === "streaming" ? "Running" : sseLogStatus === "complete" ? "Success" : "Failed"}
              </Badge>
            </DialogTitle>
          </DialogHeader>
          <div className="h-[500px] overflow-y-auto rounded-md border bg-black p-4 font-mono text-sm text-green-400">
            {sseLogLines.map((line, i) => (
              <div key={i} className={`whitespace-pre-wrap leading-5 ${line.startsWith("[stderr]") ? "text-yellow-400" : ""}`}>
                {line || "\u00A0"}
              </div>
            ))}
            {sseLogStatus === "streaming" && (
              <div className="mt-1 text-muted-foreground animate-pulse">Running...</div>
            )}
          </div>
          <div className="flex justify-end">
            {sseLogStatus === "streaming" && sseTaskId ? (
              <Button variant="destructive" onClick={handleCancelAddNode} disabled={sseCancelling}>
                {sseCancelling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {sseCancelling ? "Cancelling..." : "Cancel"}
              </Button>
            ) : sseLogStatus !== "streaming" ? (
              <Button variant="outline" onClick={() => setSseLogOpen(false)}>Close</Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete node confirmation dialog */}
      <Dialog open={!!confirmDeleteNode} onOpenChange={(o) => { if (!o) setConfirmDeleteNode(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete node?</DialogTitle>
            <DialogDescription>
              This will remove <strong>{confirmDeleteNode}</strong> from the cluster config and slurm.conf, then restart slurmctld. The node machine itself won&apos;t be touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={confirmDelete}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Node terminal dialog */}
      <Dialog open={!!terminalNode} onOpenChange={(o) => { if (!o) setTerminalNode(null); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Terminal: {terminalNode}</DialogTitle>
          </DialogHeader>
          <div className="h-[500px] overflow-y-auto rounded-md border bg-black p-3 font-mono text-sm text-green-400">
            {termLines.map((line, i) => (
              <div
                key={i}
                className={`whitespace-pre-wrap leading-5 ${
                  line.startsWith("[stderr]") ? "text-yellow-400" :
                  line.startsWith("[error]") ? "text-red-400" :
                  line.startsWith("$") ? "text-cyan-400" : ""
                }`}
              >
                {line || "\u00A0"}
              </div>
            ))}
            {termRunning && (
              <div className="inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={termCmd}
              onChange={(e) => setTermCmd(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runNodeCommand(); }}
              placeholder="Type a command..."
              className="font-mono text-sm"
              disabled={termRunning}
              autoFocus
            />
            <Button onClick={runNodeCommand} disabled={termRunning || !termCmd.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Node logs dialog */}
      <Dialog open={!!logsNode} onOpenChange={(o) => { if (!o) setLogsNode(null); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Logs: {logsNode}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-3">
            <Select
              value={logsSource}
              onValueChange={(v) => {
                setLogsSource(v);
                if (logsNode) fetchNodeLogs(logsNode, v);
              }}
            >
              <SelectTrigger className="w-[280px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="slurmd">Slurm Worker (slurmd)</SelectItem>
                <SelectItem value="munge">Munge</SelectItem>
                <SelectItem value="system">System (dmesg)</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => logsNode && fetchNodeLogs(logsNode, logsSource)}
              disabled={logsLoading}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${logsLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
          <div className="h-[500px] overflow-y-auto rounded-md border bg-black p-3 font-mono text-sm text-green-400">
            {logsLoading && logsLines.length === 0 && (
              <div className="inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Fetching logs...
              </div>
            )}
            {logsLines.map((line, i) => (
              <div
                key={i}
                className={`whitespace-pre-wrap leading-5 ${
                  line.startsWith("[stderr]") ? "text-yellow-400" :
                  line.includes("error") || line.includes("ERROR") || line.includes("fatal") ? "text-red-400" :
                  line.includes("warning") || line.includes("WARN") ? "text-yellow-400" : ""
                }`}
              >
                {line || "\u00A0"}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk add dialog */}
      <Dialog open={bulkOpen} onOpenChange={(o) => { if (!bulkRunning) setBulkOpen(o); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Bulk Add Nodes</DialogTitle>
            <DialogDescription>
              One node per line. Accepts <code className="font-mono">hostname ip</code>, <code className="font-mono">hostname,ip</code>, or <code className="font-mono">hostname,ip,user,port</code>.
              Each row runs through Test-SSH → Detect → Add.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-end">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Default SSH user</Label>
                <Input value={bulkDefaultUser} onChange={(e) => setBulkDefaultUser(e.target.value)} disabled={bulkRunning} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Default port</Label>
                <Input type="number" className="w-24" value={bulkDefaultPort}
                  onChange={(e) => setBulkDefaultPort(parseInt(e.target.value, 10) || 22)} disabled={bulkRunning} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Parallel</Label>
                <Input type="number" min={1} max={16} className="w-24" value={bulkConcurrency}
                  onChange={(e) => setBulkConcurrency(parseInt(e.target.value, 10) || 1)} disabled={bulkRunning} />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Nodes ({bulkRows.length || "preview to count"})</Label>
              <Textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={"10.0.0.11\n10.0.0.12\n# or with explicit hostname:\ngpu-1 10.0.0.13\ngpu-2,10.0.0.14,ubuntu,22"}
                className="h-48 font-mono text-sm"
                disabled={bulkRunning}
              />
              <div className="flex gap-2 pt-2">
                <Button size="sm" variant="outline" onClick={previewBulk} disabled={bulkRunning || previewRunning || !bulkText.trim()}>
                  {previewRunning ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Validating…</> : "Preview & validate"}
                </Button>
                <Button size="sm" variant="ghost" disabled={bulkRunning || previewRunning || bulkRows.length === 0}
                  onClick={() => setBulkRows([])}>
                  Clear preview
                </Button>
              </div>
            </div>
            {bulkRows.length > 0 && (
              <div className="max-h-72 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-36">Hostname</TableHead>
                      <TableHead className="w-36">IP</TableHead>
                      <TableHead className="w-28">Status</TableHead>
                      <TableHead>Message</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bulkRows.map((r, i) => (
                      <TableRow key={`${r.hostname}-${i}`}>
                        <TableCell className="font-mono text-xs">{r.hostname}</TableCell>
                        <TableCell className="font-mono text-xs">{r.ip}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={bulkStatusColor(r.status)}>
                            {r.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.msg}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkRunning}>
              Close
            </Button>
            {(() => {
              const allOk = bulkRows.length > 0 && bulkRows.every((r) => r.status === "ok" || r.status === "added");
              const anyNotAdded = bulkRows.some((r) => r.status === "ok");
              const hint = bulkRows.length === 0
                ? "Run Preview first"
                : !allOk
                  ? "All rows must pass preview (ok) before starting"
                  : !anyNotAdded
                    ? "All rows already added"
                    : undefined;
              return (
                <Button
                  onClick={runBulk}
                  disabled={bulkRunning || previewRunning || !allOk || !anyNotAdded}
                  title={hint}
                >
                  {bulkRunning ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Running…</> : "Add"}
                </Button>
              );
            })()}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deploy error dialog */}
      <Dialog open={!!deployError} onOpenChange={(o) => { if (!o) setDeployError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              Deploy failed: {deployError?.nodeName}
            </DialogTitle>
          </DialogHeader>
          <pre className="max-h-64 overflow-auto rounded-md border border-destructive/40 bg-destructive/5 p-3 font-mono text-xs whitespace-pre-wrap break-all text-destructive">
            {deployError?.message}
          </pre>
          <DialogFooter>
            {deployError && (
              <Button variant="outline" onClick={() => { const n = deployError.nodeName; setDeployError(null); openEditNode(n); }}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit node
              </Button>
            )}
            <Button onClick={() => setDeployError(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit node dialog */}
      <Dialog open={!!editTarget} onOpenChange={(o) => { if (!o) { setEditTarget(null); setEditResult(null); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit node {editTarget?.name}</DialogTitle>
            <DialogDescription>
              Rewrites this node&apos;s <code className="font-mono">NodeName=…</code> line in <code className="font-mono">slurm.conf</code> on the controller and restarts <code className="font-mono">slurmctld</code> + <code className="font-mono">slurmd</code>.
              The hostname (<strong>{editTarget?.name}</strong>) cannot be renamed — delete and re-add for that.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">IP / hostname</Label>
              <Input value={editIp} onChange={(e) => setEditIp(e.target.value)} placeholder="10.0.0.5" />
            </div>
            <div className="grid gap-3 grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">SSH user</Label>
                <Input value={editSshUser} onChange={(e) => setEditSshUser(e.target.value)} placeholder="ubuntu" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">SSH port</Label>
                <Input type="number" min={1} max={65535}
                  value={editSshPort}
                  onChange={(e) => setEditSshPort(parseInt(e.target.value, 10) || 22)} />
              </div>
            </div>

            <div className="grid gap-3 grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">CPUs</Label>
                <Input type="number" min={1} value={editCpus}
                  onChange={(e) => setEditCpus(parseInt(e.target.value, 10) || 1)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">GPUs</Label>
                <Input type="number" min={0} value={editGpus}
                  onChange={(e) => setEditGpus(parseInt(e.target.value, 10) || 0)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Memory (MB)</Label>
                <Input type="number" min={1} value={editMemoryMb}
                  onChange={(e) => setEditMemoryMb(parseInt(e.target.value, 10) || 1024)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Sockets</Label>
                <Input type="number" min={1} value={editSockets}
                  onChange={(e) => setEditSockets(parseInt(e.target.value, 10) || 1)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Cores / socket</Label>
                <Input type="number" min={1} value={editCores}
                  onChange={(e) => setEditCores(parseInt(e.target.value, 10) || 1)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Threads / core</Label>
                <Input type="number" min={1} value={editThreads}
                  onChange={(e) => setEditThreads(parseInt(e.target.value, 10) || 1)} />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Slurm rejects node registration when the configured CPUs/Sockets/Cores/Threads product differs from what <code className="font-mono">slurmd</code> reports. On VMs where hwloc is opaque, the <code className="font-mono">SlurmdParameters=config_overrides</code> default bypasses the check.
            </p>

            {editResult && (
              <pre className={`max-h-48 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all ${editResult.ok ? "" : "border-destructive/40 text-destructive"}`}>
                {editResult.output}
              </pre>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditTarget(null); setEditResult(null); }}>Close</Button>
            <Button
              onClick={submitEditNode}
              disabled={savingEdit || !editIp || !editSshUser}
            >
              {savingEdit ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
