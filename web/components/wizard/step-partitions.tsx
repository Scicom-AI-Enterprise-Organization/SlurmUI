"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, Trash2 } from "lucide-react";

export interface PartitionDefinition {
  name: string;
  nodes: string[];
  maxTime: string;
  isDefault: boolean;
}

interface StepPartitionsProps {
  partitions: PartitionDefinition[];
  availableNodeExpressions: string[];
  onChange: (partitions: PartitionDefinition[]) => void;
}

export function StepPartitions({
  partitions,
  availableNodeExpressions,
  onChange,
}: StepPartitionsProps) {
  const addPartition = () => {
    onChange([
      ...partitions,
      { name: "", nodes: [], maxTime: "24:00:00", isDefault: false },
    ]);
  };

  const removePartition = (index: number) => {
    onChange(partitions.filter((_, i) => i !== index));
  };

  const updatePartition = (
    index: number,
    field: keyof PartitionDefinition,
    value: unknown
  ) => {
    const updated = [...partitions];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  };

  const toggleNode = (partIndex: number, nodeExpr: string) => {
    const partition = partitions[partIndex];
    const nodes = partition.nodes.includes(nodeExpr)
      ? partition.nodes.filter((n) => n !== nodeExpr)
      : [...partition.nodes, nodeExpr];
    updatePartition(partIndex, "nodes", nodes);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Partitions</h3>
        <Button variant="outline" size="sm" onClick={addPartition}>
          <Plus className="mr-2 h-3 w-3" />
          Add Partition
        </Button>
      </div>

      {partitions.map((partition, index) => (
        <Card key={index}>
          <CardContent className="space-y-4 pt-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Partition Name</Label>
                <Input
                  value={partition.name}
                  onChange={(e) =>
                    updatePartition(index, "name", e.target.value)
                  }
                  placeholder="gpu"
                />
              </div>
              <div className="space-y-2">
                <Label>Max Time</Label>
                <Input
                  value={partition.maxTime}
                  onChange={(e) =>
                    updatePartition(index, "maxTime", e.target.value)
                  }
                  placeholder="24:00:00"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Node Groups</Label>
              <div className="flex flex-wrap gap-2">
                {availableNodeExpressions.map((expr) => (
                  <Button
                    key={expr}
                    variant={
                      partition.nodes.includes(expr) ? "default" : "outline"
                    }
                    size="sm"
                    onClick={() => toggleNode(index, expr)}
                  >
                    {expr}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={partition.isDefault}
                  onChange={(e) =>
                    updatePartition(index, "isDefault", e.target.checked)
                  }
                />
                Default partition
              </label>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => removePartition(index)}
              >
                <Trash2 className="mr-2 h-3 w-3" />
                Remove
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
