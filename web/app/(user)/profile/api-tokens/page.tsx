"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Copy, Check, Trash2, ExternalLink } from "lucide-react";
import Link from "next/link";

interface Token {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export default function ApiTokensPage() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [rawDialog, setRawDialog] = useState<{ raw: string; name: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<Token | null>(null);
  // Inline feedback replaces the old `toast.error` / `toast.success` calls
  // so the UI doesn't depend on a global toast container. `createErr` /
  // `listErr` render under the input / table respectively; `copied`
  // swaps the dialog's Copy icon to a Check for 2 s after a click.
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/api-tokens");
      if (!res.ok) return;
      const d = await res.json();
      setTokens(d.tokens ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    const trimmed = name.trim();
    setCreateErr(null);
    // The Create button is disabled when !name.trim() so a blank name
    // can't reach here in practice — no toast/inline message needed.
    if (!trimmed) return;
    setCreating(true);
    try {
      const res = await fetch("/api/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      // Tolerate non-JSON responses — a 500 from a mis-generated Prisma
      // client or a middleware redirect ends up with an empty body, which
      // previously crashed the page with "Unexpected end of JSON input".
      const text = await res.text();
      const d = text ? (() => { try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; } })() : {};
      if (!res.ok) {
        setCreateErr(d.error ?? `HTTP ${res.status}${res.status === 500 ? " — server error (check `docker compose logs web`; the Prisma client may need regeneration for the ApiToken model)" : ""}`);
        return;
      }
      setRawDialog({ raw: d.raw, name: trimmed });
      setName("");
      load();
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (t: Token) => {
    setConfirmRevoke(null);
    setListErr(null);
    const res = await fetch(`/api/api-tokens/${t.id}`, { method: "DELETE" });
    if (res.ok) {
      // Successful revoke is self-evident from the row dimming to
      // "revoked" on the next load() — no toast needed.
      load();
    } else {
      setListErr(`Failed to revoke "${t.name}"`);
    }
  };

  const copyToken = async (s: string) => {
    try {
      await navigator.clipboard?.writeText(s);
      setCopied(true);
      // Revert the icon back after a beat. The dialog usually stays open
      // long enough for the user to notice the green check; 2 s feels
      // right for "I saw it" without lingering after they Done out.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be blocked in insecure contexts (http on a
      // non-localhost host). Leave the icon as Copy so the user can
      // select+ctrl-c from the visible <pre> manually.
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API tokens</h1>
          <p className="text-sm text-muted-foreground">
            Personal tokens for the <code>/api/v1</code> endpoints. Use them to submit and
            list jobs from scripts, CI, or external schedulers.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/api-docs"><ExternalLink className="mr-2 h-4 w-4" /> API docs</Link>
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle>Create a new token</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="e.g. ci-submit, laptop, airflow-prod"
              value={name}
              onChange={(e) => { setName(e.target.value); setCreateErr(null); }}
              className="max-w-sm"
            />
            <Button onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </div>
          {createErr && (
            <p className="text-xs text-red-600 dark:text-red-400">{createErr}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Tokens inherit your role (<code>ADMIN</code> or <code>VIEWER</code>). The raw token is shown exactly once — copy it now.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Your tokens</CardTitle></CardHeader>
        <CardContent>
          {listErr && (
            <p className="mb-2 text-xs text-red-600 dark:text-red-400">{listErr}</p>
          )}
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">You don't have any tokens yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((t) => (
                  <TableRow key={t.id} className={t.revokedAt ? "opacity-60" : ""}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell className="font-mono text-xs">{t.prefix}…</TableCell>
                    <TableCell className="text-xs">
                      <span suppressHydrationWarning>{new Date(t.createdAt).toLocaleString()}</span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {t.lastUsedAt
                        ? <span suppressHydrationWarning>{new Date(t.lastUsedAt).toLocaleString()}</span>
                        : <span className="text-muted-foreground">never</span>}
                    </TableCell>
                    <TableCell>
                      {t.revokedAt
                        ? <Badge variant="outline" className="text-muted-foreground">revoked</Badge>
                        : <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">active</Badge>}
                    </TableCell>
                    <TableCell className="text-right">
                      {!t.revokedAt && (
                        <Button variant="ghost" size="icon-sm" onClick={() => setConfirmRevoke(t)} title="Revoke">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Raw-token one-shot dialog */}
      <Dialog
        open={!!rawDialog}
        onOpenChange={(o) => {
          if (!o) {
            setRawDialog(null);
            // Reset the copy-feedback state so the next dialog open
            // doesn't briefly flash a stale ✓ icon.
            setCopied(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New token — "{rawDialog?.name}"</DialogTitle>
            <DialogDescription>
              Copy this now. We never show the raw token again — only a prefix for identification.
            </DialogDescription>
          </DialogHeader>
          <pre className="break-all rounded-md border bg-muted p-3 font-mono text-xs">{rawDialog?.raw}</pre>
          <DialogFooter>
            {/* Icon swaps Copy → Check for 2 s on successful clipboard
                write so the user gets confirmation without a toast. */}
            <Button
              variant="outline"
              onClick={() => copyToken(rawDialog?.raw ?? "")}
              aria-live="polite"
            >
              {copied
                ? <><Check className="mr-2 h-3 w-3 text-green-600 dark:text-green-400" /> Copied</>
                : <><Copy className="mr-2 h-3 w-3" /> Copy</>}
            </Button>
            <Button onClick={() => setRawDialog(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <Dialog open={!!confirmRevoke} onOpenChange={(o) => { if (!o) setConfirmRevoke(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke "{confirmRevoke?.name}"?</DialogTitle>
            <DialogDescription>
              Any script using this token will start getting <code>401 Unauthorized</code> immediately. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRevoke(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => confirmRevoke && handleRevoke(confirmRevoke)}>
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
