"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  User as UserIcon, Mail, Shield, Server, Clock, Copy, Check, Key, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface Profile {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: "ADMIN" | "USER";
    unixUsername: string | null;
    unixUid: number | null;
    unixGid: number | null;
    createdAt: string;
  };
  hasPassword: boolean;
  clusters: Array<{
    id: string;
    name: string;
    clusterStatus: string;
    status: "PENDING" | "ACTIVE" | "FAILED" | "REMOVED";
    provisionedAt: string | null;
  }>;
  stats: { jobCount: number; runningCount: number; templateCount: number };
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const canSave = current && next.length >= 8 && next === confirm && !saving;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      toast.success("Password updated");
      setCurrent(""); setNext(""); setConfirm("");
    } catch {
      toast.error("Request failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Key className="h-4 w-4" />
          Reset password
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="curpw" className="text-xs">Current password</Label>
            <Input id="curpw" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="newpw" className="text-xs">New password</Label>
            <Input id="newpw" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cfpw" className="text-xs">Confirm new</Label>
            <Input id="cfpw" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={!canSave}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saving ? "Saving…" : "Update password"}
          </Button>
          {next && next.length < 8 && (
            <span className="text-xs text-destructive">Min 8 characters.</span>
          )}
          {confirm && next !== confirm && (
            <span className="text-xs text-destructive">Confirmation doesn&apos;t match.</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Copyable({ value }: { value: string | number | null }) {
  const [copied, setCopied] = useState(false);
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">-</span>;
  }
  const text = String(value);
  return (
    <button
      className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 font-mono text-sm hover:bg-muted"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast.success("Copied");
          setTimeout(() => setCopied(false), 1200);
        } catch {}
      }}
      title="Click to copy"
    >
      {text}
      {copied ? (
        <Check className="h-3 w-3 text-green-600" />
      ) : (
        <Copy className="h-3 w-3 text-muted-foreground" />
      )}
    </button>
  );
}

export default function ProfilePage() {
  const [data, setData] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading && !data) {
    return <p className="text-center text-muted-foreground">Loading...</p>;
  }
  if (!data) {
    return <p className="text-center text-muted-foreground">Profile unavailable</p>;
  }

  const { user, clusters, stats } = data;
  const displayName = user.name || user.email;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Profile</h1>
        <p className="text-muted-foreground">Your account and cluster access</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserIcon className="h-4 w-4" />
            Identity
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 text-sm">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Name</div>
            <div className="font-medium">{displayName}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Mail className="h-3 w-3" /> Email
            </div>
            <div className="font-medium">{user.email}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Shield className="h-3 w-3" /> Role
            </div>
            <div>
              <Badge variant={user.role === "ADMIN" ? "default" : "outline"}>
                {user.role}
              </Badge>
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" /> Member since
            </div>
            <div className="font-medium">
              {new Date(user.createdAt).toLocaleDateString()}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Linux account</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {user.unixUsername ? (
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Username</div>
                <Copyable value={user.unixUsername} />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">UID</div>
                <Copyable value={user.unixUid} />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">GID</div>
                <Copyable value={user.unixGid} />
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground">
              No Linux account assigned yet. An admin must provision you on a
              cluster before you can submit jobs or SSH in.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" />
            Cluster access ({clusters.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {clusters.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Not provisioned on any cluster. Ask an admin to add you.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cluster</TableHead>
                  <TableHead>Cluster status</TableHead>
                  <TableHead>Your access</TableHead>
                  <TableHead>Provisioned</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clusters.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        href={`/clusters/${c.id}/jobs`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{c.clusterStatus}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={
                          c.status === "ACTIVE"
                            ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                            : c.status === "FAILED"
                            ? "bg-red-100 text-red-800"
                            : c.status === "REMOVED"
                            ? "bg-gray-100 text-gray-800"
                            : "bg-yellow-100 text-yellow-800"
                        }
                      >
                        {c.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.provisionedAt
                        ? new Date(c.provisionedAt).toLocaleString()
                        : "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3 text-sm">
            <div className="rounded-md border p-4">
              <div className="text-xs text-muted-foreground">Total jobs</div>
              <div className="mt-1 text-2xl font-semibold">{stats.jobCount}</div>
            </div>
            <div className="rounded-md border p-4">
              <div className="text-xs text-muted-foreground">
                In flight (PENDING / RUNNING)
              </div>
              <div className="mt-1 text-2xl font-semibold">
                {stats.runningCount}
              </div>
            </div>
            <div className="rounded-md border p-4">
              <div className="text-xs text-muted-foreground">Saved templates</div>
              <div className="mt-1 text-2xl font-semibold">
                {stats.templateCount}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {data.hasPassword && <PasswordCard />}

      <Separator />
      <p className="text-xs text-muted-foreground">
        {data.hasPassword
          ? "Local-login account — use the form above to change your password. Email and 2FA are managed elsewhere."
          : "Password, 2FA, and email are managed in Keycloak — contact your admin for changes."}
      </p>
    </div>
  );
}
