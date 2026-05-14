"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Check, X, ChevronDown, ChevronRight } from "lucide-react";

export interface ClusterBasics {
  clusterName: string;
  controllerHost: string;
  connectionMode: "NATS" | "SSH";
  natsUrl: string;
  sshUser: string;
  sshPort: string;
  sshKeyId: string;
  sshJumpHost: string;
  sshJumpUser: string;
  sshJumpPort: string;
  sshJumpKeyId: string;
  sshProxyCommand: string;
  sshJumpProxyCommand: string;
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
  // Expand the jumphost panel by default whenever any jump field is already
  // set (e.g. when editing a pre-filled form), collapsed otherwise.
  const [jumpOpen, setJumpOpen] = useState<boolean>(!!data.sshJumpHost);

  const update = (field: keyof ClusterBasics, value: string) => {
    onChange({ ...data, [field]: value });
    // Reset SSH test when connection details change
    if (["controllerHost", "sshUser", "sshPort", "sshKeyId", "sshJumpHost", "sshJumpUser", "sshJumpPort", "sshJumpKeyId", "sshProxyCommand", "sshJumpProxyCommand"].includes(field)) {
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
          jumpHost: data.sshJumpHost || undefined,
          jumpUser: data.sshJumpUser || undefined,
          jumpPort: data.sshJumpPort ? parseInt(data.sshJumpPort) || 22 : undefined,
          jumpKeyId: data.sshJumpKeyId || undefined,
          proxyCommand: data.sshProxyCommand || undefined,
          jumpProxyCommand: data.sshJumpProxyCommand || undefined,
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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
          <CardDescription>How this cluster is named and where its controller lives.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>How SlurmUI reaches the controller and authenticates.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Connection Mode</Label>
              <Select value={data.connectionMode} onValueChange={(v) => update("connectionMode", v)}>
                <SelectTrigger className="w-full">
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

            <div className="space-y-2">
              <Label>SSH Key</Label>
              <Select value={data.sshKeyId} onValueChange={(v) => update("sshKeyId", v)}>
                <SelectTrigger className="w-full">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <button
              type="button"
              onClick={() => setJumpOpen((o) => !o)}
              className="flex w-full items-center gap-2 text-left"
            >
              {jumpOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Extra settings
              {data.sshJumpHost && !jumpOpen && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {data.sshJumpUser || "root"}@{data.sshJumpHost}
                </span>
              )}
            </button>
          </CardTitle>
          <CardDescription>Jump host and ProxyCommand — only needed when the controller is behind a bastion.</CardDescription>
        </CardHeader>
        {jumpOpen && (
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sshProxyCommand">Host ProxyCommand (advanced)</Label>
              <Input
                id="sshProxyCommand"
                placeholder="cloudflared access tcp --hostname controller.trycloudflare.com"
                value={data.sshProxyCommand}
                onChange={(e) => update("sshProxyCommand", e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Transport to reach the controller directly. When set, the jump fields below are ignored.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Jump SSH Key</Label>
              <Select
                value={data.sshJumpKeyId || "__same__"}
                onValueChange={(v) => update("sshJumpKeyId", v === "__same__" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a key" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__same__">Same as cluster key</SelectItem>
                  {sshKeys.map((key) => (
                    <SelectItem key={key.id} value={key.id}>{key.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Choose a different key if the bastion rejects the cluster key. Manage keys in Settings.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sshJumpHost">Jump Host</Label>
              <Input
                id="sshJumpHost"
                placeholder="bastion.example.com"
                value={data.sshJumpHost}
                onChange={(e) => update("sshJumpHost", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to connect directly. When set, SlurmUI reaches the controller via <code>ssh -J</code>.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sshJumpUser">Jump User</Label>
                <Input
                  id="sshJumpUser"
                  placeholder="root"
                  value={data.sshJumpUser}
                  onChange={(e) => update("sshJumpUser", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sshJumpPort">Jump Port</Label>
                <Input
                  id="sshJumpPort"
                  type="number"
                  placeholder="22"
                  value={data.sshJumpPort}
                  onChange={(e) => update("sshJumpPort", e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sshJumpProxyCommand">Jump ProxyCommand (advanced)</Label>
              <Input
                id="sshJumpProxyCommand"
                placeholder="cloudflared access tcp --hostname bastion.trycloudflare.com"
                value={data.sshJumpProxyCommand}
                onChange={(e) => update("sshJumpProxyCommand", e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Transport used to reach the jumphost (nested inside the <code>-W</code> ssh). Leave empty for a plain TCP connection to Jump Host.
              </p>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
