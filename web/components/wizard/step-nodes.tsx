"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, Trash2 } from "lucide-react";

export interface NodeDefinition {
  expression: string;
  cpus: number;
  gpus: number;
  memoryMb: number;
}

export interface HostEntry {
  hostname: string;
  ip: string;
}

interface StepNodesProps {
  nodes: NodeDefinition[];
  hosts: HostEntry[];
  onNodesChange: (nodes: NodeDefinition[]) => void;
  onHostsChange: (hosts: HostEntry[]) => void;
}

export function StepNodes({ nodes, hosts, onNodesChange, onHostsChange }: StepNodesProps) {
  const addNode = () => {
    onNodesChange([
      ...nodes,
      { expression: "", cpus: 32, gpus: 0, memoryMb: 262144 },
    ]);
  };

  const removeNode = (index: number) => {
    onNodesChange(nodes.filter((_, i) => i !== index));
  };

  const updateNode = (index: number, field: keyof NodeDefinition, value: string | number) => {
    const updated = [...nodes];
    updated[index] = { ...updated[index], [field]: value };
    onNodesChange(updated);
  };

  const addHost = () => {
    onHostsChange([...hosts, { hostname: "", ip: "" }]);
  };

  const removeHost = (index: number) => {
    onHostsChange(hosts.filter((_, i) => i !== index));
  };

  const updateHost = (index: number, field: keyof HostEntry, value: string) => {
    const updated = [...hosts];
    updated[index] = { ...updated[index], [field]: value };
    onHostsChange(updated);
  };

  return (
    <div className="space-y-8">
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-medium">Node Definitions</h3>
          <Button variant="outline" size="sm" onClick={addNode}>
            <Plus className="mr-2 h-3 w-3" />
            Add Node Group
          </Button>
        </div>
        <div className="space-y-4">
          {nodes.map((node, index) => (
            <Card key={index}>
              <CardContent className="pt-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Expression (e.g. slm-node-[01-10])</Label>
                    <Input
                      value={node.expression}
                      onChange={(e) => updateNode(index, "expression", e.target.value)}
                      placeholder="slm-node-[01-10]"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>CPUs</Label>
                    <Input
                      type="number"
                      value={node.cpus}
                      onChange={(e) => updateNode(index, "cpus", parseInt(e.target.value) || 0)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>GPUs</Label>
                    <Input
                      type="number"
                      value={node.gpus}
                      onChange={(e) => updateNode(index, "gpus", parseInt(e.target.value) || 0)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Memory (MB)</Label>
                    <Input
                      type="number"
                      value={node.memoryMb}
                      onChange={(e) =>
                        updateNode(index, "memoryMb", parseInt(e.target.value) || 0)
                      }
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => removeNode(index)}
                    >
                      <Trash2 className="mr-2 h-3 w-3" />
                      Remove
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-medium">Host Entries (expanded, one per host)</h3>
          <Button variant="outline" size="sm" onClick={addHost}>
            <Plus className="mr-2 h-3 w-3" />
            Add Host
          </Button>
        </div>
        <div className="space-y-2">
          {hosts.map((host, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                placeholder="hostname"
                value={host.hostname}
                onChange={(e) => updateHost(index, "hostname", e.target.value)}
                className="flex-1"
              />
              <Input
                placeholder="192.168.1.x"
                value={host.ip}
                onChange={(e) => updateHost(index, "ip", e.target.value)}
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeHost(index)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
