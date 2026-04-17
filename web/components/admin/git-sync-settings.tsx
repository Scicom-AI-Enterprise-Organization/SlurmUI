"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { GitBranch, Loader2, RefreshCw, AlertTriangle, Download } from "lucide-react";

interface Config {
  enabled: boolean;
  repoUrl: string;
  branch: string;
  path: string;
  deployKey: string;
  httpsToken: string;
  authorName: string;
  authorEmail: string;
  includeSecrets: boolean;
  lastSyncAt?: string;
  lastSyncStatus?: "success" | "failed";
  lastSyncMessage?: string;
}

const DEFAULT: Config = {
  enabled: false,
  repoUrl: "",
  branch: "main",
  path: "",
  deployKey: "",
  httpsToken: "",
  authorName: "SlurmUI Sync",
  authorEmail: "slurmui-sync@localhost",
  includeSecrets: false,
};

export function GitSyncSettings() {
  const [cfg, setCfg] = useState<Config>(DEFAULT);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const [syncing, setSyncing] = useState(false);
  const [logDialog, setLogDialog] = useState(false);
  const [logTitle, setLogTitle] = useState("Git sync");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logStatus, setLogStatus] = useState<"running" | "success" | "failed">("running");
  const logRef = useRef<HTMLDivElement>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  useEffect(() => {
    fetch("/api/settings/git-sync")
      .then((r) => r.json())
      .then((d) => setCfg({ ...DEFAULT, ...d }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/git-sync", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      if (res.ok) {
        const d = await res.json();
        setCfg({ ...DEFAULT, ...d });
      }
    } finally {
      setSaving(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    setLogTitle("Git sync");
    setLogLines([]);
    setLogStatus("running");
    setLogDialog(true);
    const res = await fetch("/api/sync/git", { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setLogLines([`[error] ${err.error ?? `Server returned ${res.status}`}`]);
      setLogStatus("failed");
      setSyncing(false);
      return;
    }
    const { taskId } = await res.json();
    pollTask(taskId);
  };

  const pollTask = (taskId: string) => {
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}`);
        if (!r.ok) return;
        const t = await r.json();
        setLogLines(t.logs ? t.logs.split("\n") : []);
        if (t.status === "success") {
          setLogStatus("success");
          clearInterval(poll);
          setSyncing(false);
          fetch("/api/settings/git-sync").then((r) => r.json()).then((d) => setCfg({ ...DEFAULT, ...d }));
        } else if (t.status === "failed") {
          setLogStatus("failed");
          clearInterval(poll);
          setSyncing(false);
          fetch("/api/settings/git-sync").then((r) => r.json()).then((d) => setCfg({ ...DEFAULT, ...d }));
        }
      } catch {}
    }, 1500);
  };

  const restoreNow = async () => {
    setConfirmRestore(false);
    setSyncing(true);
    setLogTitle("Git restore");
    setLogLines([]);
    setLogStatus("running");
    setLogDialog(true);
    const res = await fetch("/api/sync/git/restore", { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setLogLines([`[error] ${err.error ?? `Server returned ${res.status}`}`]);
      setLogStatus("failed");
      setSyncing(false);
      return;
    }
    const { taskId } = await res.json();
    pollTask(taskId);
  };

  const isSsh = cfg.repoUrl.startsWith("git@") || cfg.repoUrl.startsWith("ssh://");
  const isHttps = cfg.repoUrl.startsWith("http://") || cfg.repoUrl.startsWith("https://");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitBranch className="h-4 w-4" />
          Git sync
          {cfg.lastSyncStatus === "success" && (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              Last sync ok
            </Badge>
          )}
          {cfg.lastSyncStatus === "failed" && (
            <Badge variant="destructive">Last sync failed</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Export clusters, their settings, attached SSH key metadata, and recent
          job history to a git repo as YAML files. Close your eyes and the repo
          becomes a migration target for a fresh SlurmUI deployment.
        </p>

        <div className="grid gap-4 md:grid-cols-[1fr_140px_120px]">
          <div className="space-y-2">
            <Label htmlFor="git-url">Repository URL</Label>
            <Input
              id="git-url"
              placeholder="git@github.com:org/slurmui-state.git"
              value={cfg.repoUrl}
              onChange={(e) => setCfg({ ...cfg, repoUrl: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="git-branch">Branch</Label>
            <Input
              id="git-branch"
              value={cfg.branch}
              onChange={(e) => setCfg({ ...cfg, branch: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="git-path">Path</Label>
            <Input
              id="git-path"
              placeholder="(repo root)"
              value={cfg.path}
              onChange={(e) => setCfg({ ...cfg, path: e.target.value })}
            />
          </div>
        </div>

        {isSsh && (
          <div className="space-y-2">
            <Label htmlFor="git-deploy-key">SSH Deploy Key (private)</Label>
            <Textarea
              id="git-deploy-key"
              rows={4}
              className="font-mono text-xs"
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
              value={cfg.deployKey}
              onChange={(e) => setCfg({ ...cfg, deployKey: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              The matching public key must be added to the repo as a deploy key with <b>Write</b> access.
              Stored encrypted-at-rest, never shown back.
            </p>
          </div>
        )}

        {isHttps && (
          <div className="space-y-2">
            <Label htmlFor="git-token">HTTPS Personal Access Token</Label>
            <Input
              id="git-token"
              type="password"
              placeholder="github_pat_..."
              value={cfg.httpsToken}
              onChange={(e) => setCfg({ ...cfg, httpsToken: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Needs <code>repo</code> (or equivalent) push scope. Stored server-side, never shown back.
            </p>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="git-author">Commit author name</Label>
            <Input
              id="git-author"
              value={cfg.authorName}
              onChange={(e) => setCfg({ ...cfg, authorName: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="git-email">Commit author email</Label>
            <Input
              id="git-email"
              value={cfg.authorEmail}
              onChange={(e) => setCfg({ ...cfg, authorEmail: e.target.value })}
            />
          </div>
        </div>

        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-yellow-700 dark:text-yellow-400">
            <AlertTriangle className="h-4 w-4" />
            Include secrets for full migration snapshot
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="git-secrets"
              checked={cfg.includeSecrets}
              onCheckedChange={(c) => setCfg({ ...cfg, includeSecrets: !!c })}
            />
            <Label htmlFor="git-secrets" className="font-normal text-xs">
              Export SSH <b>private keys</b>, S3 access/secret keys, DB passwords, and tokens in clear text.
              Only enable if the repo is private and you trust the host — anyone with read access becomes cluster root.
            </Label>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-muted-foreground">
            {cfg.lastSyncAt ? (
              <>
                Last sync {new Date(cfg.lastSyncAt).toLocaleString()}
                {cfg.lastSyncMessage ? ` — ${cfg.lastSyncMessage}` : ""}
              </>
            ) : (
              "Never synced."
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={save} disabled={saving || loading}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
            <Button
              variant="outline"
              onClick={() => setConfirmRestore(true)}
              disabled={syncing || !cfg.repoUrl}
              title="Import clusters, SSH keys, and job history from the git repo into this SlurmUI"
            >
              <Download className="mr-2 h-4 w-4" />
              Restore from git
            </Button>
            <Button onClick={syncNow} disabled={syncing || !cfg.repoUrl}>
              {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Sync now
            </Button>
          </div>
        </div>
      </CardContent>

      {/* Sync log dialog */}
      <Dialog open={logDialog} onOpenChange={setLogDialog}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between pr-8">
              {logTitle}
              <Badge className={
                logStatus === "running" ? "bg-blue-100 text-blue-800" :
                logStatus === "success" ? "bg-green-100 text-green-800" :
                "bg-red-100 text-red-800"
              }>
                {logStatus === "running" ? "Running" : logStatus === "success" ? "Success" : "Failed"}
              </Badge>
            </DialogTitle>
          </DialogHeader>
          <div
            ref={logRef}
            className="h-[400px] overflow-y-auto rounded-md border bg-black p-3 font-mono text-xs text-green-400"
          >
            {logLines.map((line, i) => (
              <div key={i} className={`whitespace-pre-wrap leading-5 ${
                line.startsWith("[error]") ? "text-red-400" :
                line.startsWith("[sync]") ? "text-cyan-400" : ""
              }`}>
                {line || "\u00A0"}
              </div>
            ))}
            {logStatus === "running" && (
              <div className="mt-1 inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Running...
              </div>
            )}
          </div>
          <DialogFooter>
            {logStatus !== "running" && (
              <Button variant="outline" onClick={() => setLogDialog(false)}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore confirmation */}
      <Dialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Restore from git — confirm
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>This will <strong>upsert</strong> clusters, SSH keys, and job history from the repo into this SlurmUI:</p>
            <ul className="list-disc pl-5 text-muted-foreground">
              <li>Users are matched by <strong>email</strong>. New users get created; existing rows get metadata updated.</li>
              <li>Clusters are matched by <strong>name</strong>. Existing clusters with the same name get their config overwritten.</li>
              <li>SSH keys are matched by <strong>name</strong>. Only restored if the repo snapshot had <em>Include secrets</em> on.</li>
              <li>Per-cluster provisioned users (ClusterUser) restored — requires the user to be in the users index.</li>
              <li>Templates are matched by <strong>(cluster, owner email, template name)</strong>. Skipped if owner isn&apos;t in the user table.</li>
              <li>Active (PENDING/RUNNING) jobs plus the last 500 finished jobs are inserted; jobs with a matching ID are never clobbered.</li>
            </ul>
            <p className="pt-2 text-muted-foreground">
              Your live clusters aren&apos;t touched — after restore, open each cluster&apos;s
              settings tabs and click <strong>Apply</strong> to push the restored state to nodes.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRestore(false)}>Cancel</Button>
            <Button variant="destructive" onClick={restoreNow}>
              <Download className="mr-2 h-4 w-4" />
              Restore now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
