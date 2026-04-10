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
import { toast } from "sonner";
import { RefreshCw, Plus, Zap } from "lucide-react";

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
  const [activating, setActivating] = useState<string | null>(null);

  // Add node form state
  const [newNodeName, setNewNodeName] = useState("");
  const [newNodeIp, setNewNodeIp] = useState("");
  const [newNodeCpus, setNewNodeCpus] = useState(32);
  const [newNodeGpus, setNewNodeGpus] = useState(0);
  const [newNodeMemory, setNewNodeMemory] = useState(262144);
  const [addingNode, setAddingNode] = useState(false);

  const fetchNodes = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/nodes`);
      if (res.ok) {
        const data = await res.json();
        setNodes(data.nodes ?? data ?? []);
      }
    } catch {
      toast.error("Error", {
        description: "Failed to fetch nodes",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNodes();
  }, [clusterId]);

  const handleActivate = async (nodeName: string) => {
    setActivating(nodeName);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/nodes/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeName }),
      });

      if (res.ok) {
        toast.success("Success", { description: `Node ${nodeName} activated.` });
        fetchNodes();
      } else {
        const err = await res.json();
        toast.error("Error", {
          description: err.error ?? "Failed to activate node",
        });
      }
    } finally {
      setActivating(null);
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
          cpus: newNodeCpus,
          gpus: newNodeGpus,
          memoryMb: newNodeMemory,
        }),
      });

      if (res.ok) {
        toast.success("Success", { description: `Node ${newNodeName} added.` });
        setNewNodeName("");
        setNewNodeIp("");
        fetchNodes();
      } else {
        const err = await res.json();
        toast.error("Error", {
          description: err.error ?? "Failed to add node",
        });
      }
    } finally {
      setAddingNode(false);
    }
  };

  const stateColor = (state: string) => {
    const lower = state.toLowerCase();
    if (lower.includes("idle")) return "bg-green-100 text-green-800";
    if (lower.includes("alloc") || lower.includes("mix")) return "bg-blue-100 text-blue-800";
    if (lower.includes("down") || lower.includes("drain")) return "bg-red-100 text-red-800";
    if (lower.includes("future")) return "bg-gray-100 text-gray-800";
    return "bg-gray-100 text-gray-800";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Node Management</h1>
          <p className="text-muted-foreground">
            View, activate, and add nodes to this cluster
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchNodes} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Node
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Node</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Hostname</Label>
                  <Input
                    value={newNodeName}
                    onChange={(e) => setNewNodeName(e.target.value)}
                    placeholder="slm-node-11"
                  />
                </div>
                <div className="space-y-2">
                  <Label>IP Address</Label>
                  <Input
                    value={newNodeIp}
                    onChange={(e) => setNewNodeIp(e.target.value)}
                    placeholder="192.168.1.20"
                  />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>CPUs</Label>
                    <Input
                      type="number"
                      value={newNodeCpus}
                      onChange={(e) => setNewNodeCpus(parseInt(e.target.value) || 0)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>GPUs</Label>
                    <Input
                      type="number"
                      value={newNodeGpus}
                      onChange={(e) => setNewNodeGpus(parseInt(e.target.value) || 0)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Memory (MB)</Label>
                    <Input
                      type="number"
                      value={newNodeMemory}
                      onChange={(e) => setNewNodeMemory(parseInt(e.target.value) || 0)}
                    />
                  </div>
                </div>
                <Button
                  onClick={handleAddNode}
                  disabled={addingNode || !newNodeName || !newNodeIp}
                  className="w-full"
                >
                  {addingNode ? "Adding..." : "Add Node"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

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
                    <TableCell>{Math.round(node.memory / 1024)} GB</TableCell>
                    <TableCell>{node.partitions?.join(", ") ?? "-"}</TableCell>
                    <TableCell>
                      {node.state.toLowerCase().includes("future") && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleActivate(node.name)}
                          disabled={activating === node.name}
                        >
                          <Zap className="mr-1 h-3 w-3" />
                          {activating === node.name ? "Activating..." : "Activate"}
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
    </div>
  );
}
