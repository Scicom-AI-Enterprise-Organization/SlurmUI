"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ClusterBasics {
  clusterName: string;
  controllerHost: string;
  connectionMode: "NATS" | "SSH";
  natsUrl: string;
  sshUser: string;
  sshPort: string;
  sshKeyId: string;
}

export interface SshKeyOption {
  id: string;
  name: string;
}

interface StepBasicsProps {
  data: ClusterBasics;
  onChange: (data: ClusterBasics) => void;
  sshKeys: SshKeyOption[];
}

export function StepBasics({ data, onChange, sshKeys }: StepBasicsProps) {
  const update = (field: keyof ClusterBasics, value: string) => {
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
        <Label htmlFor="controllerHost">Controller Host</Label>
        <Input
          id="controllerHost"
          placeholder="10.0.1.10 or slm-master.internal"
          value={data.controllerHost}
          onChange={(e) => update("controllerHost", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          IP address or hostname of the master node. Must be reachable via SSH.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Connection Mode</Label>
        <Select value={data.connectionMode} onValueChange={(v) => update("connectionMode", v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="SSH">SSH (direct, no agent)</SelectItem>
            <SelectItem value="NATS">NATS (agent-based)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {data.connectionMode === "SSH"
            ? "Commands run directly over SSH. Simpler setup, no agent binary needed on the node."
            : "An agent runs on the node and communicates via NATS. Better for real-time streaming and multi-node setups."}
        </p>
      </div>

      {data.connectionMode === "NATS" && (
        <div className="space-y-2">
          <Label htmlFor="natsUrl">NATS URL (agent callback)</Label>
          <Input
            id="natsUrl"
            placeholder="nats://100.97.85.61:4222"
            value={data.natsUrl}
            onChange={(e) => update("natsUrl", e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            The NATS address the remote agent connects back to. Must be reachable from the cluster node.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label>SSH Key</Label>
        <Select value={data.sshKeyId} onValueChange={(v) => update("sshKeyId", v)}>
          <SelectTrigger>
            <SelectValue placeholder="Select an SSH key" />
          </SelectTrigger>
          <SelectContent>
            {sshKeys.map((key) => (
              <SelectItem key={key.id} value={key.id}>
                {key.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          The SSH key used to connect to this cluster. Manage keys in Settings.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="sshUser">SSH User</Label>
          <Input
            id="sshUser"
            placeholder="root"
            value={data.sshUser}
            onChange={(e) => update("sshUser", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sshPort">SSH Port</Label>
          <Input
            id="sshPort"
            type="number"
            placeholder="22"
            value={data.sshPort}
            onChange={(e) => update("sshPort", e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
