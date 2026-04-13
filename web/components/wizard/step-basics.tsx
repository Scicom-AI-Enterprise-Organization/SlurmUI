"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface StepBasicsProps {
  data: {
    clusterName: string;
    controllerHost: string;
  };
  onChange: (data: StepBasicsProps["data"]) => void;
}

export function StepBasics({ data, onChange }: StepBasicsProps) {
  const update = (field: keyof StepBasicsProps["data"], value: string) => {
    onChange({ ...data, [field]: value });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="clusterName">Cluster Name</Label>
        <Input
          id="clusterName"
          placeholder="sci-cluster-01"
          value={data.clusterName}
          onChange={(e) => update("clusterName", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Unique identifier. Lowercase and hyphens only.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="controllerHost">Controller Hostname</Label>
        <Input
          id="controllerHost"
          placeholder="slm-master"
          value={data.controllerHost}
          onChange={(e) => update("controllerHost", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          The hostname of the master/controller node. Must be resolvable from other nodes.
        </p>
      </div>
    </div>
  );
}
