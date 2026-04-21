"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  UserPlus, Copy, Check, Trash2, KeyRound, Loader2,
} from "lucide-react";

type Role = "ADMIN" | "VIEWER";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  unixUsername: string | null;
  unixUid: number | null;
  emailVerified: string | null;
  provider: "keycloak" | "local";
  hasPassword: boolean;
  clusterCount: number;
  createdAt: string;
}

interface InviteRow {
  id: string;
  email: string | null;
  role: Role;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  createdBy: { email: string; name: string | null };
  tokenPreview: string;
}

// Renders a date/datetime in the viewer's locale. Deferred to post-mount so
// SSR output ("") matches the first client render — avoids hydration
// mismatches when the server is in UTC and the browser is elsewhere.
function ClientDate({ iso, mode = "datetime" }: { iso: string; mode?: "datetime" | "date" }) {
  const [s, setS] = useState("");
  useEffect(() => {
    const d = new Date(iso);
    setS(mode === "date" ? d.toLocaleDateString() : d.toLocaleString());
  }, [iso, mode]);
  return <span suppressHydrationWarning>{s}</span>;
}

export default function OrganizationPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("VIEWER");
  const [inviteHours, setInviteHours] = useState(24);
  const [creating, setCreating] = useState(false);

  // Generated invite link dialog (single moment we expose the token)
  const [linkDialog, setLinkDialog] = useState<{ url: string; role: Role; expiresAt: string } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  // Role-change confirmation dialog — replaces toast so the admin explicitly
  // OKs a role change (they're clicking a select, easy to mis-pick).
  const [roleChange, setRoleChange] = useState<{ user: UserRow; nextRole: Role } | null>(null);
  const [roleChanging, setRoleChanging] = useState(false);
  const [roleChangeError, setRoleChangeError] = useState<string | null>(null);

  // Delete user confirmation dialog.
  const [deleteFor, setDeleteFor] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Password reset — admin generates a link, user follows it to set their pw.
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<{ email: string; url: string; expiresAt: string } | null>(null);
  const [resetLinkCopied, setResetLinkCopied] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [u, i] = await Promise.all([
        fetch("/api/admin/users").then((r) => r.json()),
        fetch("/api/invites").then((r) => r.json()),
      ]);
      setUsers(Array.isArray(u) ? u : []);
      setInvites(Array.isArray(i) ? i : []);
    } catch {
      // silent — don't toast-spam transient network blips
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const createInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail.trim() || undefined,
          role: inviteRole,
          expiresInHours: inviteHours,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? `Server returned ${res.status}`);
        return;
      }
      const url = `${window.location.origin}/invite/${d.token}`;
      setLinkDialog({ url, role: d.role, expiresAt: d.expiresAt });
      setInviteEmail("");
      await refresh();
    } finally {
      setCreating(false);
    }
  };

  const revokeInvite = async (id: string) => {
    const res = await fetch(`/api/invites/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Invite revoked");
      refresh();
    } else {
      toast.error("Failed to revoke");
    }
  };

  // Kick off the confirm dialog. The actual PATCH happens on dialog-confirm
  // so a stray click in the Select doesn't silently change anything.
  const requestRoleChange = (u: UserRow, nextRole: Role) => {
    if (u.role === nextRole) return;
    setRoleChangeError(null);
    setRoleChange({ user: u, nextRole });
  };

  const confirmRoleChange = async () => {
    if (!roleChange) return;
    const { user, nextRole } = roleChange;
    setRoleChanging(true);
    setRoleChangeError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRoleChangeError(d.error ?? `Failed (${res.status})`);
        return;
      }
      setRoleChange(null);
      refresh();
    } finally {
      setRoleChanging(false);
    }
  };

  const requestDelete = (u: UserRow) => {
    setDeleteError(null);
    setDeleteFor(u);
  };

  const confirmDelete = async () => {
    if (!deleteFor) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/admin/users/${deleteFor.id}`, { method: "DELETE" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError(d.error ?? `Failed (${res.status})`);
        return;
      }
      setDeleteFor(null);
      refresh();
    } finally {
      setDeleting(false);
    }
  };

  const issueResetLink = async (u: UserRow) => {
    setResettingId(u.id);
    try {
      const res = await fetch(`/api/admin/users/${u.id}/reset-link`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 5xx = server bug — surface to console, don't spam a toast. 4xx is
        // user-actionable (e.g. Keycloak-only account) so we still toast.
        if (res.status >= 500) {
          console.error("[reset-link] server error", res.status, d);
        } else {
          toast.error(d.error ?? `Failed (${res.status})`);
        }
        return;
      }
      setResetLink({
        email: u.email,
        url: `${window.location.origin}/reset/${d.token}`,
        expiresAt: d.expiresAt,
      });
    } finally {
      setResettingId(null);
    }
  };

  const pending = invites.filter((i) => !i.usedAt && new Date(i.expiresAt) > new Date());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Organization</h1>
        <p className="text-muted-foreground">Manage users and invitations</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4" /> Invite by link
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={createInvite} className="grid gap-3 md:grid-cols-[1fr_140px_120px_auto] items-end">
            <div className="space-y-1">
              <Label htmlFor="inv-email">Email (optional — locks the invite if set)</Label>
              <Input
                id="inv-email"
                type="email"
                placeholder="alice@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Role</Label>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as Role)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                  <SelectItem value="VIEWER">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="inv-hours">Expires (hours)</Label>
              <Input
                id="inv-hours"
                type="number"
                min={1}
                max={720}
                value={inviteHours}
                onChange={(e) => setInviteHours(parseInt(e.target.value || "24", 10))}
              />
            </div>
            <Button type="submit" disabled={creating}>
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate link
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            The link is shown <b>once</b> — the token is not stored in plain form and cannot be retrieved later.
            Admins can do everything; viewers are read-only (dashboards + job output, no submit/modify).
          </p>
        </CardContent>
      </Card>

      {pending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending invites ({pending.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email lock</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.email ?? <span className="text-muted-foreground">any</span>}</TableCell>
                    <TableCell><Badge variant="outline">{i.role}</Badge></TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {i.createdBy.name ?? i.createdBy.email}
                    </TableCell>
                    <TableCell><ClientDate iso={i.expiresAt} /></TableCell>
                    <TableCell className="font-mono text-xs">{i.tokenPreview}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => revokeInvite(i.id)}>
                        <Trash2 className="h-3 w-3" /> Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members ({users.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Linux user</TableHead>
                  <TableHead>Clusters</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>{u.name ?? <span className="text-muted-foreground">-</span>}</TableCell>
                    <TableCell className="font-mono text-sm">{u.email}</TableCell>
                    <TableCell>
                      <Select value={u.role} onValueChange={(v) => requestRoleChange(u, v as Role)}>
                        <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ADMIN">Admin</SelectItem>
                          <SelectItem value="VIEWER">Viewer</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.provider === "local" ? "default" : "outline"}>
                        {u.provider === "local" ? "Local" : "Keycloak"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {u.unixUsername ? `${u.unixUsername} (${u.unixUid})` : <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell>{u.clusterCount}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <ClientDate iso={u.createdAt} mode="date" />
                    </TableCell>
                    <TableCell className="text-right">
                      {u.provider === "local" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => issueResetLink(u)}
                          disabled={resettingId === u.id}
                          title="Generate a password reset link"
                        >
                          {resettingId === u.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <KeyRound className="h-3 w-3" />
                          )}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => requestDelete(u)}
                        title="Delete user"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Generated link — visible exactly once */}
      <Dialog open={!!linkDialog} onOpenChange={(o) => { if (!o) { setLinkDialog(null); setLinkCopied(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite link generated</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Copy this link now — it&apos;s the only time it will be shown. It grants the role{" "}
              <Badge>{linkDialog?.role}</Badge> and expires{" "}
              {linkDialog && new Date(linkDialog.expiresAt).toLocaleString()}.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={linkDialog?.url ?? ""} className="font-mono text-xs" />
              <Button
                variant="outline"
                onClick={async () => {
                  if (!linkDialog) return;
                  await navigator.clipboard.writeText(linkDialog.url);
                  setLinkCopied(true);
                  toast.success("Copied");
                  setTimeout(() => setLinkCopied(false), 1500);
                }}
              >
                {linkCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => { setLinkDialog(null); setLinkCopied(false); }}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm delete user */}
      <Dialog
        open={!!deleteFor}
        onOpenChange={(o) => { if (!o && !deleting) { setDeleteFor(null); setDeleteError(null); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Delete user?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              <span className="font-medium">{deleteFor?.email}</span> will be removed, along with
              their cluster provisioning, saved templates, and app sessions. <b>This cannot be undone.</b>
            </p>
            <p className="text-xs text-muted-foreground">
              If the user has submitted jobs, delete or reassign those first — the server rejects
              the delete to keep job history intact.
            </p>
            {deleteError && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
                {deleteError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setDeleteFor(null); setDeleteError(null); }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm role change */}
      <Dialog
        open={!!roleChange}
        onOpenChange={(o) => { if (!o && !roleChanging) { setRoleChange(null); setRoleChangeError(null); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change role?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              <span className="font-medium">{roleChange?.user.email}</span> will change from{" "}
              <Badge variant="outline">{roleChange?.user.role}</Badge> to{" "}
              <Badge>{roleChange?.nextRole}</Badge>.
            </p>
            {roleChange?.nextRole === "VIEWER" && (
              <p className="text-xs text-muted-foreground">
                Viewers are read-only — they can see dashboards and job output but cannot submit,
                cancel, or modify anything.
              </p>
            )}
            {roleChange?.nextRole === "ADMIN" && (
              <p className="text-xs text-muted-foreground">
                Admins have full access, including managing users and clusters.
              </p>
            )}
            {roleChangeError && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
                {roleChangeError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setRoleChange(null); setRoleChangeError(null); }}
              disabled={roleChanging}
            >
              Cancel
            </Button>
            <Button onClick={confirmRoleChange} disabled={roleChanging}>
              {roleChanging && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Change role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password reset link — shown once */}
      <Dialog
        open={!!resetLink}
        onOpenChange={(o) => { if (!o) { setResetLink(null); setResetLinkCopied(false); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Password reset link for {resetLink?.email}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Send this link to the user. Copy it now — it&apos;s shown only once and expires{" "}
              {resetLink && new Date(resetLink.expiresAt).toLocaleString()}.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={resetLink?.url ?? ""} className="font-mono text-xs" />
              <Button
                variant="outline"
                onClick={async () => {
                  if (!resetLink) return;
                  await navigator.clipboard.writeText(resetLink.url);
                  setResetLinkCopied(true);
                  toast.success("Copied");
                  setTimeout(() => setResetLinkCopied(false), 1500);
                }}
              >
                {resetLinkCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => { setResetLink(null); setResetLinkCopied(false); }}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
