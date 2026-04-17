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
import { toast } from "sonner";
import { RefreshCw, Plus, Zap, Loader2, Check, X, Wrench, Terminal as TerminalIcon, Trash2, Send, FileText, Server, Stethoscope } from "lucide-react";

interface NodeInfo {
  name: string;
  state: string;
  cpus: number;
  memory: number;
  gpus?: number;
  gres?: string;
  partitions: string[];
}

export default function NodesPage() {
  const params = useParams();
  const clusterId = params.id as string;

  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [clusterStatus, setClusterStatus] = useState<string>("");

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

  // SSH test state for new node
  const [nodeTestStatus, setNodeTestStatus] = useState<"idle" | "testing" | "ok" | "failed">("idle");
  const [nodeTestMsg, setNodeTestMsg] = useState("");
  const [detecting, setDetecting] = useState(false);

  // Per-node action state
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
      toast.error("Failed to fetch nodes");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNodes();
    fetch(`/api/clusters/${clusterId}`)
      .then((r) => r.json())
      .then((d) => setClusterStatus(d.status ?? ""))
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
    } catch {
      setSseCancelling(false);
    }
  };

  const handleAddNode = async () => {
    setAddingNode(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/nodes/add`, {
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
        toast.error(err.error ?? "Failed to start add-node");
        return;
      }

      const data = await res.json();
      setAddDialogOpen(false);

      if (data.taskId) {
        // Background task mode: poll for logs (survives X close)
        setSseLogTitle("Adding new node");
        setSseLogLines([]);
        setSseLogStatus("streaming");
        setSseTaskId(data.taskId);
        setSseCancelling(false);
        setSseLogOpen(true);

        const poll = setInterval(async () => {
          try {
            const taskRes = await fetch(`/api/tasks/${data.taskId}`);
            if (!taskRes.ok) return;
            const task = await taskRes.json();
            setSseLogLines(task.logs ? task.logs.split("\n") : []);
            if (task.status === "success") {
              setSseLogStatus("complete");
              setSseTaskId(null);
              setSseCancelling(false);
              clearInterval(poll);
              fetchNodes();
            } else if (task.status === "failed") {
              setSseLogStatus("error");
              setSseTaskId(null);
              setSseCancelling(false);
              clearInterval(poll);
            }
          } catch {}
        }, 2000);
      } else if (data.request_id) {
        // NATS mode: open LiveLogDialog
        setAddRequestId(data.request_id);
        setAddLogOpen(true);
      }

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
      // Run directly on controller (skip nested SSH which breaks through bastion)
      const cmd = source === "system"
        ? "sudo dmesg --time-format iso | tail -100"
        : `sudo journalctl -u ${source} --no-pager -n 100 --output short-iso 2>/dev/null || echo 'Service ${source} not found'`;
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

  const stateColor = (state: string) => {
    const s = state.toLowerCase();
    if (s.includes("idle")) return "bg-green-100 text-green-800";
    if (s.includes("alloc") || s.includes("mix")) return "bg-blue-100 text-blue-800";
    if (s.includes("down") || s.includes("drain")) return "bg-red-100 text-red-800";
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
          <Button
            disabled={clusterStatus !== "ACTIVE"}
            title={clusterStatus !== "ACTIVE" ? "Bootstrap the cluster first" : undefined}
            onClick={() => setAddDialogOpen(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Node
          </Button>
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

      {clusterStatus && clusterStatus !== "ACTIVE" && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          Cluster must be bootstrapped before adding nodes. Click the <strong>Bootstrap</strong> button above to set up the controller first.
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
                    <TableCell>{node.partitions?.join(", ") ?? "-"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
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
    </div>
  );
}
