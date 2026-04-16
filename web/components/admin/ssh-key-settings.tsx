"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyRound, Copy, Check, Trash2, Plus } from "lucide-react";

interface SshKeyRecord {
  id: string;
  name: string;
  publicKey: string;
  createdAt: string;
  _count: { clusters: number };
}

interface SshKeySettingsProps {
  initialKeys: SshKeyRecord[];
}

export function SshKeySettings({ initialKeys }: SshKeySettingsProps) {
  const [keys, setKeys] = useState<SshKeyRecord[]>(initialKeys);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [privateKeyInput, setPrivateKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/ssh-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, privateKey: privateKeyInput }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setKeys((prev) => [{ ...data, _count: { clusters: 0 } }, ...prev]);
      setName("");
      setPrivateKeyInput("");
      setShowAdd(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/admin/ssh-keys/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error);
        return;
      }
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleCopy(id: string, publicKey: string) {
    await navigator.clipboard.writeText(publicKey);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">SSH Keys</CardTitle>
          </div>
          <Badge variant="outline">{keys.length} key{keys.length !== 1 ? "s" : ""}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          SSH keys are used to connect to cluster nodes during agent deployment and setup.
          Each cluster is assigned a specific key.
        </p>

        {/* Key list */}
        {keys.length === 0 && !showAdd && (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No SSH keys configured. Add one to start creating clusters.
          </div>
        )}

        {keys.map((key) => (
          <div key={key.id} className="rounded-md border p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{key.name}</span>
                {key._count.clusters > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {key._count.clusters} cluster{key._count.clusters !== 1 ? "s" : ""}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => handleCopy(key.id, key.publicKey)}
                  title="Copy public key"
                >
                  {copiedId === key.id ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => handleDelete(key.id)}
                  disabled={deletingId === key.id || key._count.clusters > 0}
                  title={key._count.clusters > 0 ? "In use by clusters" : "Delete key"}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <pre className="rounded bg-muted px-3 py-2 text-xs font-mono break-all whitespace-pre-wrap">
              {key.publicKey}
            </pre>
          </div>
        ))}

        {/* Add key form */}
        {showAdd ? (
          <div className="rounded-md border p-4 space-y-3">
            <div className="space-y-2">
              <Label htmlFor="key-name" className="text-sm font-medium">Key Name</Label>
              <Input
                id="key-name"
                placeholder="production-cluster-key"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(null); }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="private-key" className="text-sm font-medium">Private Key</Label>
              <Textarea
                id="private-key"
                rows={6}
                placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                value={privateKeyInput}
                onChange={(e) => { setPrivateKeyInput(e.target.value); setError(null); }}
                className="font-mono text-xs"
              />
            </div>
            {error && <p className="text-sm text-destructive whitespace-pre-wrap">{error}</p>}
            <div className="flex items-center gap-2">
              <Button onClick={handleAdd} disabled={saving || !name.trim() || !privateKeyInput.trim()}>
                {saving ? "Saving..." : "Save Key"}
              </Button>
              <Button variant="outline" onClick={() => { setShowAdd(false); setError(null); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" onClick={() => setShowAdd(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add SSH Key
          </Button>
        )}

        <div className="rounded-md border bg-muted/40 px-4 py-3 space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Generate a key
          </p>
          <pre className="text-xs font-mono">
            ssh-keygen -t ed25519 -C aura-cluster-key -f ~/.ssh/aura_cluster_key
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}
