"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Clock, Copy, Check, Trash2, Plus } from "lucide-react";

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
    // Page-level layout mirrors /admin/gpu-providers — h1 + description
    // on the left, primary action button on the right, no wrapping Card.
    // Each list row + the inline add form are bordered blocks (not Cards)
    // so the page reads as a flat list of items rather than nested cards.
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">SSH Keys</h1>
          <p className="text-muted-foreground">
            SSH keys for connecting to cluster nodes during agent deployment
            and setup. Each cluster is assigned a specific key.
          </p>
        </div>
        {/* Hidden while the inline add form is open so the user doesn't
            see a redundant trigger above the live form. */}
        {!showAdd && (
          <Button onClick={() => setShowAdd(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add SSH Key
          </Button>
        )}
      </div>

      <div className="space-y-4">
        {/* Generate-a-key helper — at the top so a new admin sees the
            command right away and can paste a freshly-generated key
            into the form without scrolling. */}
        <div className="rounded-md border bg-muted/40 px-4 py-3 space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Generate a key
          </p>
          <pre className="text-xs font-mono">
            ssh-keygen -t ed25519 -C aura-cluster-key -f ~/.ssh/aura_cluster_key
          </pre>
        </div>

        {/* Key list — empty state matches GPU providers' empty-state
            (centred, larger padding, dashed border). */}
        {keys.length === 0 && !showAdd && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12">
            <p className="text-lg text-muted-foreground">No SSH keys yet</p>
            <Button variant="outline" className="mt-4" onClick={() => setShowAdd(true)}>
              Add your first key
            </Button>
          </div>
        )}

        {keys.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {keys.map((key) => (
              <Card key={key.id} className="transition-colors hover:border-primary/60 hover:shadow-md">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-base font-semibold truncate">{key.name}</CardTitle>
                  {key._count.clusters > 0 ? (
                    <Badge variant="secondary" className="text-xs shrink-0">
                      {key._count.clusters} cluster{key._count.clusters !== 1 ? "s" : ""}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs shrink-0">Unused</Badge>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    <span>Created {new Date(key.createdAt).toLocaleDateString()}</span>
                  </div>
                  <pre className="rounded bg-muted px-2 py-1.5 text-[11px] font-mono break-all whitespace-pre-wrap line-clamp-3">
                    {key.publicKey}
                  </pre>
                  <div className="flex items-center justify-end gap-1">
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
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Add key form — `&&` because the trigger button now lives in
            the card header, not here, so we don't need a sibling branch
            to render when `!showAdd`. */}
        {showAdd && (
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
        )}
      </div>
    </div>
  );
}
