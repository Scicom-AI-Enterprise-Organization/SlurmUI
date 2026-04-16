"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Check, X, Save } from "lucide-react";

interface SshKeyOption {
  id: string;
  name: string;
}

interface SshSettingsEditorProps {
  clusterId: string;
  initialHost: string;
  initialUser: string;
  initialPort: number;
  initialBastion: boolean;
  initialSshKeyId: string | null;
  sshKeys: SshKeyOption[];
}

export function SshSettingsEditor({
  clusterId,
  initialHost,
  initialUser,
  initialPort,
  initialBastion,
  initialSshKeyId,
  sshKeys,
}: SshSettingsEditorProps) {
  const router = useRouter();
  const [host, setHost] = useState(initialHost);
  const [user, setUser] = useState(initialUser);
  const [port, setPort] = useState(String(initialPort));
  const [bastion, setBastion] = useState(initialBastion);
  const [sshKeyId, setSshKeyId] = useState(initialSshKeyId ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // SSH test
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "failed">("idle");
  const [testMsg, setTestMsg] = useState("");

  const hasChanges =
    host !== initialHost ||
    user !== initialUser ||
    port !== String(initialPort) ||
    bastion !== initialBastion ||
    sshKeyId !== (initialSshKeyId ?? "");

  const canTest = !!(host && sshKeyId);

  const testSsh = async () => {
    setTestStatus("testing");
    setTestMsg("");
    try {
      const res = await fetch("/api/admin/ssh-keys/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sshKeyId,
          host,
          user: user || "root",
          port: parseInt(port) || 22,
        }),
      });
      const result = await res.json();
      if (res.ok && result.success) {
        setTestStatus("ok");
        setTestMsg(result.hostname ? `Connected to ${result.hostname}` : "Connection successful");
      } else {
        setTestStatus("failed");
        setTestMsg(result.error ?? "Connection failed");
      }
    } catch {
      setTestStatus("failed");
      setTestMsg("Request failed");
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch(`/api/clusters/${clusterId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          controllerHost: host,
          sshUser: user || "root",
          sshPort: parseInt(port) || 22,
          sshBastion: bastion,
          sshKeyId: sshKeyId || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to save");
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      router.refresh();
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">SSH Connection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Controller Host</Label>
          <Input
            value={host}
            onChange={(e) => { setHost(e.target.value); setTestStatus("idle"); }}
            placeholder="10.0.1.10 or hostname"
          />
        </div>

        <div className="space-y-2">
          <Label>SSH Key</Label>
          <Select value={sshKeyId} onValueChange={(v) => { setSshKeyId(v); setTestStatus("idle"); }}>
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
        </div>

        <div className="grid grid-cols-[1fr_1fr_auto] gap-4 items-end">
          <div className="space-y-2">
            <Label>SSH User</Label>
            <Input
              value={user}
              onChange={(e) => { setUser(e.target.value); setTestStatus("idle"); }}
              placeholder="root"
            />
          </div>
          <div className="space-y-2">
            <Label>SSH Port</Label>
            <Input
              type="number"
              value={port}
              onChange={(e) => { setPort(e.target.value); setTestStatus("idle"); }}
              placeholder="22"
            />
          </div>
          <Button
            variant={testStatus === "ok" ? "outline" : "secondary"}
            disabled={!canTest || testStatus === "testing"}
            onClick={testSsh}
          >
            {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {testStatus === "ok" && <Check className="mr-2 h-4 w-4 text-green-600" />}
            {testStatus === "failed" && <X className="mr-2 h-4 w-4 text-destructive" />}
            {testStatus === "testing" ? "Testing..." : "Test SSH"}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="bastion"
            checked={bastion}
            onChange={(e) => { setBastion(e.target.checked); setTestStatus("idle"); }}
            className="h-4 w-4 rounded border-input"
          />
          <Label htmlFor="bastion">Bastion / jump server (no direct command execution)</Label>
        </div>

        {testStatus === "ok" && (
          <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
            {testMsg}
          </Badge>
        )}
        {testStatus === "failed" && (
          <p className="text-sm text-destructive">{testMsg}</p>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={saving || !hasChanges}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {saving ? "Saving..." : "Save"}
          </Button>
          {saved && (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              Saved
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
