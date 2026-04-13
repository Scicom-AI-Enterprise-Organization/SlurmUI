"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyRound, Copy, Check, Trash2, ShieldCheck, AlertTriangle } from "lucide-react";

interface SshKeySettingsProps {
  initialConfigured: boolean;
  initialPublicKey: string | null;
}

export function SshKeySettings({ initialConfigured, initialPublicKey }: SshKeySettingsProps) {
  const [configured, setConfigured] = useState(initialConfigured);
  const [publicKey, setPublicKey] = useState(initialPublicKey);
  const [privateKeyInput, setPrivateKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settings/ssh-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ privateKey: privateKeyInput }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setConfigured(true);
      setPublicKey(data.publicKey);
      setPrivateKeyInput("");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await fetch("/api/admin/settings/ssh-key", { method: "DELETE" });
      setConfigured(false);
      setPublicKey(null);
      setPrivateKeyInput("");
    } finally {
      setRemoving(false);
    }
  }

  async function handleCopy() {
    if (!publicKey) return;
    await navigator.clipboard.writeText(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Cluster SSH Key</CardTitle>
          </div>
          {configured
            ? <Badge className="bg-green-100 text-green-700"><ShieldCheck className="mr-1 h-3 w-3" />Configured</Badge>
            : <Badge variant="destructive"><AlertTriangle className="mr-1 h-3 w-3" />Not configured</Badge>
          }
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Aura uses this key to reach cluster nodes via Ansible during setup. Generate one with:
        </p>
        <pre className="rounded-md bg-muted px-3 py-2 text-xs font-mono overflow-x-auto">
          ssh-keygen -t ed25519 -C aura-cluster-key -f ~/.ssh/aura_cluster_key
        </pre>

        {/* Public key display */}
        {configured && publicKey && (
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Public Key
            </Label>
            <div className="relative">
              <pre className="rounded-md border bg-muted px-3 py-2 pr-12 text-xs font-mono break-all whitespace-pre-wrap">
                {publicKey}
              </pre>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1 h-8 w-8"
                onClick={handleCopy}
                title="Copy public key"
              >
                {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>

            {/* Hints — not prescriptive */}
            <div className="rounded-md border bg-muted/40 px-4 py-3 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Hint — ways to authorize this key on your nodes
              </p>
              <p className="text-xs text-muted-foreground">
                You can provision nodes however you like. The only requirement is that this public key
                is in <code className="bg-muted px-1 rounded">/root/.ssh/authorized_keys</code> on every node before onboarding starts.
              </p>
              <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                <li>
                  <strong>Manually:</strong>{" "}
                  <code className="bg-muted px-1 rounded">
                    echo "&lt;key&gt;" &gt;&gt; /root/.ssh/authorized_keys
                  </code>
                </li>
                <li>
                  <strong>AWS EC2 User Data:</strong> inject it at launch time so every instance starts
                  with the key already authorized — no manual step needed.
                </li>
                <li>
                  <strong>Cloud-init / Ansible bootstrap:</strong> write it via{" "}
                  <code className="bg-muted px-1 rounded">ssh_authorized_keys</code> in your cloud-init
                  config, or a pre-provisioning playbook.
                </li>
              </ul>
            </div>
          </div>
        )}

        {/* Private key input */}
        <div className="space-y-2">
          <Label htmlFor="private-key" className="text-sm font-medium">
            {configured ? "Replace private key" : "Paste private key"}
          </Label>
          <Textarea
            id="private-key"
            rows={8}
            placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
            value={privateKeyInput}
            onChange={(e) => { setPrivateKeyInput(e.target.value); setError(null); }}
            className="font-mono text-xs"
          />
          {error && <p className="text-sm text-destructive whitespace-pre-wrap">{error}</p>}
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={saving || !privateKeyInput.trim()}>
            {saving ? "Saving…" : configured ? "Update key" : "Save key"}
          </Button>
          {configured && (
            <Button variant="destructive" size="sm" onClick={handleRemove} disabled={removing}>
              <Trash2 className="mr-2 h-4 w-4" />
              {removing ? "Removing…" : "Remove key"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
