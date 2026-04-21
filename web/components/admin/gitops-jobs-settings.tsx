"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { GitCommit, Loader2, RefreshCw, Upload, History } from "lucide-react";

interface Config {
  enabled: boolean;
  repoUrl: string;
  branch: string;
  path: string;
  deployKey: string;
  httpsToken: string;
  intervalSec: number;
  lastReconcileAt?: string;
  lastStatus?: "success" | "failed";
  lastMessage?: string;
}

const DEFAULT: Config = {
  enabled: false,
  repoUrl: "",
  branch: "main",
  path: "",
  deployKey: "",
  httpsToken: "",
  intervalSec: 60,
};

interface LastRun {
  id: string;
  status: "running" | "success" | "failed";
  createdAt: string;
  completedAt: string | null;
  logs: string;
  truncated: boolean;
}

export function GitopsJobsSettings() {
  const [cfg, setCfg] = useState<Config>(DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [running, setRunning] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logTitle, setLogTitle] = useState("GitOps reconcile");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logStatus, setLogStatus] = useState<"running" | "success" | "failed">("running");
  const logRef = useRef<HTMLDivElement>(null);

  const [lastReconcile, setLastReconcile] = useState<LastRun | null>(null);
  const [lastMirror, setLastMirror] = useState<LastRun | null>(null);

  const fetchLastRuns = () => {
    fetch("/api/sync/jobs/last-runs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setLastReconcile(d.reconcile ?? null);
        setLastMirror(d.exportRunning ?? null);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetch("/api/sync/jobs/config")
      .then((r) => r.json())
      .then((d) => setCfg({ ...DEFAULT, ...d }))
      .finally(() => setLoading(false));
    fetchLastRuns();
    // Poll so a cron tick that runs in the background shows up without a
    // manual refresh. 10s keeps the DB load trivial.
    const h = setInterval(fetchLastRuns, 10_000);
    return () => clearInterval(h);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/sync/jobs/config", {
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

  const runTask = async (endpoint: string, title: string) => {
    setRunning(true);
    setLogTitle(title);
    setLogLines([]);
    setLogStatus("running");
    setLogOpen(true);
    const res = await fetch(endpoint, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setLogLines([`[error] ${err.error ?? `Server returned ${res.status}`}`]);
      setLogStatus("failed");
      setRunning(false);
      return;
    }
    const { taskId } = await res.json();
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}`);
        if (!r.ok) return;
        const t = await r.json();
        setLogLines(t.logs ? t.logs.split("\n") : []);
        if (t.status === "success" || t.status === "failed") {
          setLogStatus(t.status);
          clearInterval(poll);
          setRunning(false);
          fetch("/api/sync/jobs/config").then((r) => r.json()).then((d) => setCfg({ ...DEFAULT, ...d }));
          fetchLastRuns();
        }
      } catch {}
    }, 1500);
  };

  const reconcileNow = () => runTask("/api/sync/jobs/reconcile", "GitOps reconcile");
  const exportRunning = () => runTask("/api/sync/jobs/export-running", "Mirror running jobs");

  const isSsh = cfg.repoUrl.startsWith("git@") || cfg.repoUrl.startsWith("ssh://");
  const isHttps = cfg.repoUrl.startsWith("http://") || cfg.repoUrl.startsWith("https://");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCommit className="h-4 w-4" />
          Git Jobs
          {cfg.enabled ? (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Enabled</Badge>
          ) : (
            <Badge variant="outline">Disabled</Badge>
          )}
          {cfg.lastStatus === "success" && (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Last ok</Badge>
          )}
          {cfg.lastStatus === "failed" && <Badge variant="destructive">Last failed</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Two modes against the same repo. <b>Reconcile</b> scans
          <code className="mx-1">jobs/**/*.yaml</code> and submits / cancels to match;
          off by default — flip the switch to start the cron.
          <b className="ml-1">Mirror running jobs</b> pushes a snapshot of every live
          job into <code className="mx-1">running/</code> so the repo doubles as a
          read-only view of cluster state. Mirror runs on demand regardless of the
          reconciler toggle.
        </p>

        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label htmlFor="gj-enabled" className="font-medium">Enabled</Label>
            <p className="text-xs text-muted-foreground">
              When on, the server ticks every <code>{Math.max(60, cfg.intervalSec)}s</code> and reconciles.
            </p>
          </div>
          <Switch
            id="gj-enabled"
            checked={cfg.enabled}
            onCheckedChange={(c) => setCfg({ ...cfg, enabled: c })}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-[1fr_140px_120px_120px]">
          <div className="space-y-2">
            <Label htmlFor="gj-url">Repository URL</Label>
            <Input
              id="gj-url"
              placeholder="git@github.com:org/aura-jobs.git"
              value={cfg.repoUrl}
              onChange={(e) => setCfg({ ...cfg, repoUrl: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gj-branch">Branch</Label>
            <Input id="gj-branch" value={cfg.branch} onChange={(e) => setCfg({ ...cfg, branch: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gj-path">Path</Label>
            <Input id="gj-path" placeholder="(repo root)" value={cfg.path} onChange={(e) => setCfg({ ...cfg, path: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gj-interval">Interval (s)</Label>
            <Input
              id="gj-interval"
              type="number"
              min={60}
              value={cfg.intervalSec}
              onChange={(e) => setCfg({ ...cfg, intervalSec: parseInt(e.target.value || "60", 10) })}
            />
          </div>
        </div>

        <details className="rounded-md border bg-muted/30 p-3 text-xs">
          <summary className="cursor-pointer font-medium text-foreground">
            How do I push to a private repo?
          </summary>
          <div className="mt-3 space-y-3 text-muted-foreground">
            <p>
              The reconciler needs <b>read</b> access. The <b>Mirror running jobs</b> feature additionally
              needs <b>write</b> access since it commits + pushes snapshots under <code>running/</code>.
              Pick whichever auth works for your host.
            </p>

            <div>
              <div className="font-medium text-foreground">Option 1 — HTTPS + Personal Access Token (easiest)</div>
              <p className="mt-1">
                Paste the plain HTTPS URL in the <b>Repository URL</b> field and put your PAT in
                the <b>HTTPS Personal Access Token</b> field below. The PAT is masked after save.
              </p>
              <pre className="mt-1 overflow-x-auto rounded bg-background/60 p-2 font-mono">{`URL:   https://github.com/your-org/aura-jobs.git
Token: ghp_abcdef1234567890    (GitHub classic PAT with 'repo' scope
                                — or fine-grained PAT with Contents: Read & Write
                                  if you plan to use Mirror running jobs)`}</pre>
              <p className="mt-1">
                GitLab: use <code>glpat-…</code>. Bitbucket: use an App Password.
              </p>
            </div>

            <div>
              <div className="font-medium text-foreground">Option 2 — Inline credentials in the URL</div>
              <p className="mt-1">
                Embed the username and PAT/password directly; leave the HTTPS token field empty.
                URL-encode special chars (<code>@ → %40</code>, <code># → %23</code>, <code>/ → %2F</code>).
              </p>
              <pre className="mt-1 overflow-x-auto rounded bg-background/60 p-2 font-mono">{`https://<user>:<PAT>@github.com/your-org/aura-jobs.git
https://oauth2:glpat-XXXX@gitlab.com/your-org/aura-jobs.git
https://x-token-auth:<app-password>@bitbucket.org/your-org/aura-jobs.git`}</pre>
              <p className="mt-1">
                The password part must be a token since GitHub removed git
                password auth in 2021. On save the URL is shown back credential-stripped so
                the secret doesn&apos;t leak back to the browser.
              </p>
            </div>

            <div>
              <div className="font-medium text-foreground">Option 3 — SSH Deploy Key</div>
              <p className="mt-1">
                Paste the SSH URL in the <b>Repository URL</b> field. Generate a keypair (e.g.
                <code className="ml-1">ssh-keygen -t ed25519 -N &apos;&apos; -f /tmp/key</code>),
                add the public key to your repo as a <b>deploy key</b> (read-only if you only
                use Reconcile; write if you use Mirror running jobs), and paste the private key below.
              </p>
              <pre className="mt-1 overflow-x-auto rounded bg-background/60 p-2 font-mono">{`git@github.com:your-org/aura-jobs.git`}</pre>
            </div>

            <p>
              First-time setup: create an empty repo with a <code>jobs/</code> folder and at least
              one manifest, point this settings page at it, save, and flip <b>Enabled</b> on — the cron
              runs within 60s.
            </p>
          </div>
        </details>

        {isSsh && (
          <div className="space-y-2">
            <Label htmlFor="gj-deploy-key">SSH Deploy Key (read-only is fine)</Label>
            <Textarea
              id="gj-deploy-key"
              rows={4}
              className="font-mono text-xs"
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
              value={cfg.deployKey}
              onChange={(e) => setCfg({ ...cfg, deployKey: e.target.value })}
            />
          </div>
        )}

        {isHttps && (
          <div className="space-y-2">
            <Label htmlFor="gj-token">HTTPS Personal Access Token</Label>
            <Input
              id="gj-token"
              type="password"
              placeholder="github_pat_..."
              value={cfg.httpsToken}
              onChange={(e) => setCfg({ ...cfg, httpsToken: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">Read-only scope is enough — reconciler only clones.</p>
          </div>
        )}

        <details className="rounded-md border bg-muted/30 p-3 text-xs">
          <summary className="cursor-pointer font-medium text-foreground">Manifest format</summary>
          <pre className="mt-2 overflow-x-auto rounded bg-background/60 p-2 font-mono">{`# jobs/<anything>/<name>.yaml
apiVersion: aura/v1
kind: Job
metadata:
  name: train-001              # unique per cluster
  cluster: gpu-a               # cluster name (must exist)
  user: alice@example.com      # must match an existing User.email
spec:
  partition: gpu
  script: |
    #!/bin/bash
    #SBATCH --gres=gpu:1
    srun python train.py`}</pre>
          <p className="mt-2 text-muted-foreground">
            Changing the script or any field → cancel + resubmit. Removing the
            file → cancel + drop. Unchanged files are skipped (content-hashed).
          </p>
        </details>

        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-muted-foreground">
            {cfg.lastReconcileAt ? (
              <>
                Last run {new Date(cfg.lastReconcileAt).toLocaleString()}
                {cfg.lastMessage ? ` — ${cfg.lastMessage}` : ""}
              </>
            ) : (
              "Never reconciled."
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={save} disabled={saving || loading}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
            <Button
              variant="outline"
              onClick={exportRunning}
              disabled={running || !cfg.repoUrl}
              title="Push a snapshot of every PENDING/RUNNING job into <repo>/running/ as YAML"
            >
              {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Mirror running jobs
            </Button>
            <Button onClick={reconcileNow} disabled={running || !cfg.enabled || !cfg.repoUrl}>
              {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Reconcile now
            </Button>
          </div>
        </div>

        <div className="space-y-3 pt-4 border-t">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <History className="h-4 w-4" /> Last runs
            </div>
            <Button variant="ghost" size="sm" onClick={fetchLastRuns}>
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
          <LastRunBlock label="Reconcile" run={lastReconcile} />
          <LastRunBlock label="Mirror running jobs" run={lastMirror} />
        </div>
      </CardContent>

      <Dialog open={logOpen} onOpenChange={setLogOpen}>
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
                line.startsWith("[gitops]") || line.startsWith("[export]") ? "text-cyan-400" : ""
              }`}>
                {line || "\u00A0"}
              </div>
            ))}
            {logStatus === "running" && (
              <div className="mt-1 inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Running...
              </div>
            )}
          </div>
          <DialogFooter>
            {logStatus !== "running" && (
              <Button variant="outline" onClick={() => setLogOpen(false)}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function LastRunBlock({ label, run }: { label: string; run: LastRun | null }) {
  if (!run) {
    return (
      <div className="rounded-md border p-3 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">{label}</div>
        <div className="mt-1">No runs yet.</div>
      </div>
    );
  }
  const lines = (run.logs ?? "").split("\n");
  return (
    <div className="rounded-md border p-3 text-xs">
      <div className="flex items-center justify-between">
        <div className="font-medium text-foreground">{label}</div>
        <div className="flex items-center gap-2">
          <Badge className={
            run.status === "running" ? "bg-blue-100 text-blue-800" :
            run.status === "success" ? "bg-green-100 text-green-800" :
            "bg-red-100 text-red-800"
          }>
            {run.status}
          </Badge>
          <span className="text-muted-foreground">
            {new Date(run.completedAt ?? run.createdAt).toLocaleString()}
          </span>
        </div>
      </div>
      <div className="mt-2 max-h-64 overflow-y-auto rounded-md border bg-black p-2 font-mono text-[11px] text-green-400">
        {run.truncated && (
          <div className="mb-1 text-muted-foreground">… (truncated, showing tail)</div>
        )}
        {lines.map((line, i) => (
          <div
            key={i}
            className={`whitespace-pre-wrap leading-4 ${
              line.startsWith("[error]") ? "text-red-400" :
              line.startsWith("[gitops]") || line.startsWith("[export]") ? "text-cyan-400" : ""
            }`}
          >
            {line || "\u00A0"}
          </div>
        ))}
      </div>
    </div>
  );
}
