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
} from "@/components/ui/dialog";
import { LiveLogDialog } from "@/components/ui/live-log-dialog";
import { toast } from "sonner";
import { RefreshCw, Plus, Zap, Loader2, Check, X } from "lucide-react";

interface NodeInfo {
  name: string;
  state: string;
  cpus: number;
  memory: number;
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
  const [addingNode, setAddingNode] = useState(false);
  const [addRequestId, setAddRequestId] = useState<string | null>(null);
  const [addLogOpen, setAddLogOpen] = useState(false);

  // SSH test state for new node
  const [nodeTestStatus, setNodeTestStatus] = useState<"idle" | "testing" | "ok" | "failed">("idle");
  const [nodeTestMsg, setNodeTestMsg] = useState("");
  const [detecting, setDetecting] = useState(false);

  // SSE log state (for SSH mode)
  const [sseLogLines, setSseLogLines] = useState<string[]>([]);
  const [sseLogOpen, setSseLogOpen] = useState(false);
  const [sseLogStatus, setSseLogStatus] = useState<"streaming" | "complete" | "error">("streaming");

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
            if (detectResult.memoryGb) setNewNodeMemory(detectResult.memoryGb);
            if (detectResult.gpus !== undefined) setNewNodeGpus(detectResult.gpus);
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
          memoryMb: newNodeMemory,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        toast.error(err.error ?? "Failed to start add-node");
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      setAddDialogOpen(false);

      if (contentType.includes("text/event-stream") && res.body) {
        // SSH mode: stream logs directly
        setSseLogLines([]);
        setSseLogStatus("streaming");
        setSseLogOpen(true);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "stream") {
                setSseLogLines((prev) => [...prev, event.line]);
              } else if (event.type === "complete") {
                if (event.success) {
                  setSseLogStatus("complete");
                  toast.success("Node added successfully");
                  fetchNodes();
                } else {
                  setSseLogStatus("error");
                }
                return;
              }
            } catch {}
          }
        }
        // Flush remaining
        if (buffer.trim()) {
          buffer += "\n\n";
          const parts = buffer.split("\n\n");
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "complete") {
                setSseLogStatus(event.success ? "complete" : "error");
                if (event.success) { toast.success("Node added successfully"); fetchNodes(); }
              }
            } catch {}
          }
        }
      } else {
        // NATS mode: get request_id and open LiveLogDialog
        const data = await res.json();
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

  const stateColor = (state: string) => {
    const s = state.toLowerCase();
    if (s.includes("idle")) return "bg-green-100 text-green-800";
    if (s.includes("alloc") || s.includes("mix")) return "bg-blue-100 text-blue-800";
    if (s.includes("down") || s.includes("drain")) return "bg-red-100 text-red-800";
    return "bg-gray-100 text-gray-800";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchNodes} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
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
                      <p className="text-xs text-muted-foreground">Node name in slurm.conf. Auto-filled from hostname.</p>
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
                      disabled={addingNode || !newNodeName || !newNodeIp}
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
          <CardTitle>Nodes ({nodes.length})</CardTitle>
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
                    <TableCell>{node.partitions?.join(", ") ?? "-"}</TableCell>
                    <TableCell>
                      {node.state.toLowerCase().includes("future") && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleActivate(node.name)}
                          disabled={activatingNode === node.name}
                        >
                          <Zap className="mr-1 h-3 w-3" />
                          {activatingNode === node.name ? "Queuing..." : "Activate"}
                        </Button>
                      )}
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
      <Dialog open={sseLogOpen} onOpenChange={sseLogStatus !== "streaming" ? setSseLogOpen : undefined}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              Adding new node
              <Badge className={
                sseLogStatus === "streaming" ? "bg-blue-100 text-blue-800" :
                sseLogStatus === "complete" ? "bg-green-100 text-green-800" :
                "bg-red-100 text-red-800"
              }>
                {sseLogStatus === "streaming" ? "Running" : sseLogStatus === "complete" ? "Success" : "Failed"}
              </Badge>
            </DialogTitle>
          </DialogHeader>
          <div className="h-80 overflow-y-auto rounded-md border bg-black p-4 font-mono text-xs text-green-400">
            {sseLogLines.map((line, i) => (
              <div key={i} className={`whitespace-pre-wrap leading-5 ${line.startsWith("[stderr]") ? "text-yellow-400" : ""}`}>
                {line || "\u00A0"}
              </div>
            ))}
            {sseLogStatus === "streaming" && (
              <div className="mt-1 text-muted-foreground animate-pulse">Running...</div>
            )}
          </div>
          {sseLogStatus !== "streaming" && (
            <Button variant="outline" onClick={() => setSseLogOpen(false)}>Close</Button>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
