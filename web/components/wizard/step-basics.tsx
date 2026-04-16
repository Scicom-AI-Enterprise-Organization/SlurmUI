"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Check, X } from "lucide-react";

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

export type SshTestStatus = "idle" | "testing" | "ok" | "failed";

interface StepBasicsProps {
  data: ClusterBasics;
  onChange: (data: ClusterBasics) => void;
  sshKeys: SshKeyOption[];
  onSshTestChange?: (status: SshTestStatus) => void;
}

export function StepBasics({ data, onChange, sshKeys, onSshTestChange }: StepBasicsProps) {
  const [sshTest, setSshTest] = useState<SshTestStatus>("idle");
  const [sshTestMsg, setSshTestMsg] = useState("");

  const update = (field: keyof ClusterBasics, value: string) => {
    onChange({ ...data, [field]: value });
    // Reset SSH test when connection details change
    if (["controllerHost", "sshUser", "sshPort", "sshKeyId"].includes(field)) {
      setSshTest("idle");
      setSshTestMsg("");
      onSshTestChange?.("idle");
    }
  };

  const canTestSsh = !!(data.controllerHost && data.sshKeyId);

  const testSsh = async () => {
    setSshTest("testing");
    setSshTestMsg("");
    onSshTestChange?.("testing");
    try {
      const res = await fetch("/api/admin/ssh-keys/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sshKeyId: data.sshKeyId,
          host: data.controllerHost,
          user: data.sshUser || "root",
          port: parseInt(data.sshPort) || 22,
        }),
      });
      const result = await res.json();
      if (res.ok && result.success) {
        setSshTest("ok");
        setSshTestMsg(result.hostname ? `Connected to ${result.hostname}` : "Connection successful");
        onSshTestChange?.("ok");
      } else {
        setSshTest("failed");
        setSshTestMsg(result.error ?? "Connection failed");
        onSshTestChange?.("failed");
      }
    } catch {
      setSshTest("failed");
      setSshTestMsg("Request failed");
      onSshTestChange?.("failed");
    }
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

      <div className="grid grid-cols-[1fr_1fr_auto] gap-4 items-end">
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
        <Button
          type="button"
          variant={sshTest === "ok" ? "outline" : "secondary"}
          size="default"
          disabled={!canTestSsh || sshTest === "testing"}
          onClick={testSsh}
        >
          {sshTest === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {sshTest === "ok" && <Check className="mr-2 h-4 w-4 text-green-600" />}
          {sshTest === "failed" && <X className="mr-2 h-4 w-4 text-destructive" />}
          {sshTest === "testing" ? "Testing..." : "Test SSH"}
        </Button>
      </div>
      {sshTest === "ok" && (
        <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
          {sshTestMsg}
        </Badge>
      )}
      {sshTest === "failed" && (
        <p className="text-sm text-destructive">{sshTestMsg}</p>
      )}
    </div>
  );
}
