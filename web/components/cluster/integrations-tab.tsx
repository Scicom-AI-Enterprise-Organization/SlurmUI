"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Trash2, Loader2, Check, X, FlaskConical, ExternalLink, Pencil, KeyRound } from "lucide-react";
import { toast } from "sonner";
import type { ExperimentTracker, TrackerBackend } from "@/lib/experiment-trackers/types";

/** Server-projected Git credential — token stripped, hasToken=true. */
export interface GithubCredView {
  id: string;
  name: string;
  username?: string;
  hasToken: true;
  createdAt: string;
  updatedAt?: string;
}

interface Props {
  clusterId: string;
  initialTrackers: ExperimentTracker[];
  initialGithub: GithubCredView[];
}

const BACKEND_LABELS: Record<TrackerBackend, string> = {
  mlflow: "MLflow",
  wandb: "Weights & Biases",
  comet: "Comet",
};

// Trackers returned by the API include `hasPassword: boolean` (the password
// itself is stripped on read). The form keeps password as a string — blank
// means "no change" in edit mode, set means "replace".
type TrackerRow = ExperimentTracker & { hasPassword?: boolean };

export function IntegrationsTab({ clusterId, initialTrackers, initialGithub }: Props) {
  const [trackers, setTrackers] = useState<TrackerRow[]>(initialTrackers);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<ExperimentTracker | null>(null);
  // Edit dialog state. `editTarget` doubles as the open/close flag and the
  // tracker we're editing. Form state below is initialised when an Edit
  // button is clicked, never reused across opens (so a discarded edit on
  // tracker A doesn't bleed into tracker B).
  const [editTarget, setEditTarget] = useState<TrackerRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editUri, setEditUri] = useState("");
  const [editDefaultExperiment, setEditDefaultExperiment] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [editPassword, setEditPassword] = useState("");
  // Edit mode treats blank password as "keep existing"; we display a
  // placeholder hinting at that when the tracker already has one.
  const [editClearPassword, setEditClearPassword] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  // Git credentials state. Hydrated from the server. Tokens are never
  // shipped to the client — every list item only carries `hasToken: true`.
  // The dialog supports both "add new" and "rotate existing", controlled
  // by `ghEditTarget`: null = add, a credView = rotate that one.
  const [ghCreds, setGhCreds] = useState<GithubCredView[]>(initialGithub);
  const [ghOpen, setGhOpen] = useState(false);
  const [ghEditTarget, setGhEditTarget] = useState<GithubCredView | null>(null);
  const [ghName, setGhName] = useState("");
  const [ghUsername, setGhUsername] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [ghTestStatus, setGhTestStatus] = useState<"idle" | "testing" | "ok" | "failed">("idle");
  const [ghTestMsg, setGhTestMsg] = useState("");
  const [ghSaving, setGhSaving] = useState(false);
  const [ghSaveError, setGhSaveError] = useState<string>("");
  const [ghConfirmRemove, setGhConfirmRemove] = useState<GithubCredView | null>(null);

  const openGhAdd = () => {
    setGhEditTarget(null);
    setGhName("");
    setGhUsername("");
    setGhToken("");
    setGhTestStatus("idle");
    setGhTestMsg("");
    setGhSaveError("");
    setGhOpen(true);
  };
  const openGhRotate = (c: GithubCredView) => {
    setGhEditTarget(c);
    setGhName(c.name);
    setGhUsername(c.username ?? "");
    setGhToken("");
    setGhTestStatus("idle");
    setGhTestMsg("");
    setGhSaveError("");
    setGhOpen(true);
  };

  const handleGhTest = async () => {
    setGhTestStatus("testing");
    setGhTestMsg("");
    try {
      const res = await fetch(`/api/clusters/${clusterId}/code-credentials/github/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: ghToken }),
      });
      const data = await res.json();
      if (data.success) {
        setGhTestStatus("ok");
        setGhTestMsg(data.message ?? "Authenticated");
      } else {
        setGhTestStatus("failed");
        setGhTestMsg(data.error ?? "Test failed");
      }
    } catch {
      setGhTestStatus("failed");
      setGhTestMsg("Request failed");
    }
  };

  const handleGhSave = async () => {
    setGhSaving(true);
    setGhSaveError("");
    try {
      const url = ghEditTarget
        ? `/api/clusters/${clusterId}/code-credentials/github/${ghEditTarget.id}`
        : `/api/clusters/${clusterId}/code-credentials/github`;
      const res = await fetch(url, {
        method: ghEditTarget ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: ghName.trim() || undefined,
          username: ghUsername.trim() || undefined,
          token: ghToken || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Inline error inside the dialog — no toast. Keep the dialog open
        // so the user can correct + retry without re-typing the token.
        setGhSaveError(err.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      // Optimistic local update — server returns the freshly-saved row.
      setGhCreds((prev) =>
        ghEditTarget
          ? prev.map((c) => (c.id === ghEditTarget.id ? data.credential : c))
          : [...prev, data.credential],
      );
      setGhOpen(false);
    } finally {
      setGhSaving(false);
    }
  };

  const handleGhRemove = async () => {
    const target = ghConfirmRemove;
    if (!target) return;
    setGhConfirmRemove(null);
    const res = await fetch(
      `/api/clusters/${clusterId}/code-credentials/github/${target.id}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      // Roll back: server kept the row. Reopen the confirm so the user
      // sees the error and can decide what to do.
      const err = await res.json().catch(() => ({}));
      setGhSaveError(err.error ?? `HTTP ${res.status}`);
      setGhConfirmRemove(target);
      return;
    }
    setGhCreds((prev) => prev.filter((c) => c.id !== target.id));
  };

  // Token must be non-empty to test (no point hitting GitHub with nothing).
  // Save validity:
  //   - Add path: name + token + ok test
  //   - Rotate path: name set + (either token + ok test, OR token blank = keep existing)
  const ghCanTest = ghToken.length >= 8;
  const ghCanSave = !ghSaving
    && ghName.trim().length > 0
    && (
      ghEditTarget
        ? (ghToken.length === 0 || ghTestStatus === "ok")
        : (ghToken.length > 0 && ghTestStatus === "ok")
    );

  // New-tracker form. Phase 1 forces backend to "mlflow"; later phases unlock
  // the rest, but the form structure stays the same — we'd just enable the
  // disabled options and let the backend-specific fields render conditionally.
  const [newName, setNewName] = useState("");
  const [newBackend, setNewBackend] = useState<TrackerBackend>("mlflow");
  const [newUri, setNewUri] = useState("");
  const [newDefaultExperiment, setNewDefaultExperiment] = useState("aura-jobs");
  // Optional Basic-auth credentials. MLflow's Python client sends them as
  // Authorization: Basic <base64(user:pass)>, so the field labels match
  // what the client docs call them. Leave blank for unauthenticated MLflow.
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "failed">("idle");
  const [testMsg, setTestMsg] = useState("");
  const [creating, setCreating] = useState(false);

  const resetForm = () => {
    setNewName("");
    setNewBackend("mlflow");
    setNewUri("");
    setNewDefaultExperiment("aura-jobs");
    setNewUsername("");
    setNewPassword("");
    setTestStatus("idle");
    setTestMsg("");
  };
  const resetTest = () => {
    setTestStatus("idle");
    setTestMsg("");
  };

  const canTest = !!newUri && /^https?:\/\//i.test(newUri);
  const canCreate = !!newName.trim() && canTest && testStatus === "ok" && !creating;

  const handleTest = async () => {
    setTestStatus("testing");
    setTestMsg("");
    try {
      const res = await fetch(`/api/clusters/${clusterId}/integrations/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend: newBackend,
          trackingUri: newUri,
          username: newUsername.trim() || undefined,
          password: newPassword || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setTestStatus("ok");
        setTestMsg(data.message ?? "Connection successful");
      } else {
        setTestStatus("failed");
        setTestMsg(data.error ?? "Test failed");
      }
    } catch {
      setTestStatus("failed");
      setTestMsg("Request failed");
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/integrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          backend: newBackend,
          trackingUri: newUri.trim(),
          defaultExperimentName: newDefaultExperiment.trim() || undefined,
          username: newUsername.trim() || undefined,
          password: newPassword || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error ?? "Failed to create tracker");
        return;
      }
      const data = await res.json();
      setTrackers([...trackers, data.tracker]);
      setAddOpen(false);
      resetForm();
    } finally {
      setCreating(false);
    }
  };

  const doRemove = async () => {
    const t = confirmRemove;
    if (!t) return;
    setConfirmRemove(null);
    const res = await fetch(`/api/clusters/${clusterId}/integrations/${t.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error ?? "Failed to remove tracker");
      return;
    }
    setTrackers(trackers.filter((x) => x.id !== t.id));
  };

  const openEdit = (t: TrackerRow) => {
    setEditTarget(t);
    setEditName(t.name);
    setEditUri(t.trackingUri);
    setEditDefaultExperiment(t.defaultExperimentName ?? "");
    setEditUsername(t.username ?? "");
    setEditPassword("");
    setEditClearPassword(false);
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    setSavingEdit(true);
    try {
      // Build a minimal patch — only send fields that actually changed, so
      // an accidental rename in the UI doesn't overwrite a field we never
      // intended to touch. Password handling: blank = keep, "" via the
      // explicit "Clear" toggle = clear, non-empty = replace.
      const patch: Record<string, unknown> = {};
      if (editName.trim() !== editTarget.name) patch.name = editName.trim();
      if (editUri.trim() !== editTarget.trackingUri) patch.trackingUri = editUri.trim();
      if ((editDefaultExperiment.trim() || "") !== (editTarget.defaultExperimentName ?? "")) {
        patch.defaultExperimentName = editDefaultExperiment.trim();
      }
      if ((editUsername.trim() || "") !== (editTarget.username ?? "")) {
        patch.username = editUsername.trim();
      }
      if (editPassword.length > 0) {
        patch.password = editPassword;
      } else if (editClearPassword) {
        patch.password = "";
      }
      if (Object.keys(patch).length === 0) {
        toast.info("No changes");
        setEditTarget(null);
        return;
      }
      const res = await fetch(`/api/clusters/${clusterId}/integrations/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error ?? "Failed to update tracker");
        return;
      }
      const data = await res.json();
      setTrackers(trackers.map((x) => (x.id === editTarget.id ? data.tracker : x)));
      setEditTarget(null);
      toast.success("Tracker updated");
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Tracker
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="h-4 w-4" />
            Experiment Trackers ({trackers.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {trackers.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No experiment trackers configured. Add an MLflow server to auto-link jobs to runs.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Backend</TableHead>
                  <TableHead>Tracking URI</TableHead>
                  <TableHead>Default Experiment</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trackers.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{BACKEND_LABELS[t.backend] ?? t.backend}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      <a
                        href={t.trackingUri}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                      >
                        {t.trackingUri}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {t.defaultExperimentName ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Edit tracker"
                          onClick={() => openEdit(t)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive"
                          title="Remove tracker"
                          onClick={() => setConfirmRemove(t)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Git Credentials — one or more GitHub PATs. Each job submitted on
          this cluster can pick one (the new-job page exposes a selector).
          Stored on cluster.config.code_credentials.github (array); submit-job.ts
          injects the chosen entry's token as GITHUB_TOKEN via the same
          per-job secrets file pattern as MLflow/W&B passwords. Tokens are
          never returned to the client — each row only carries hasToken:true. */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" />
              Git Credentials ({ghCreds.length})
            </CardTitle>
            <Button size="sm" onClick={openGhAdd}>
              <Plus className="mr-2 h-4 w-4" />
              Add Token
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {ghCreds.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No Git credentials configured. Add a GitHub Personal Access
              Token so jobs on this cluster can{" "}
              <code className="font-mono">git clone</code> private repos.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ghCreds.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">GitHub</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {c.username ?? <span className="text-muted-foreground">x-access-token</span>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.createdAt
                        ? new Date(c.createdAt).toLocaleDateString()
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Rotate token / rename"
                          onClick={() => openGhRotate(c)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive"
                          title="Remove credential"
                          onClick={() => setGhConfirmRemove(c)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add / rotate Git credential dialog. Same shape for both modes;
          the title + token-field placeholder switch based on ghEditTarget. */}
      <Dialog
        open={ghOpen}
        onOpenChange={(o) => {
          setGhOpen(o);
          if (!o) {
            setGhEditTarget(null);
            setGhName("");
            setGhUsername("");
            setGhToken("");
            setGhTestStatus("idle");
            setGhTestMsg("");
            setGhSaveError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {ghEditTarget ? "Edit Git Credential" : "Add Git Credential"}
            </DialogTitle>
            <DialogDescription>
              Generate a PAT at{" "}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                github.com/settings/tokens
              </a>{" "}
              with <code className="font-mono">repo</code> (classic) or
              fine-grained <code className="font-mono">Contents: Read</code> for
              the private repos jobs need to clone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={ghName}
                onChange={(e) => setGhName(e.target.value)}
                placeholder="team-bot / personal / ci"
              />
              <p className="text-xs text-muted-foreground">
                Lets users pick this credential when submitting a job. Must be unique on this cluster.
              </p>
            </div>
            <div className="space-y-1">
              <Label>Username (optional)</Label>
              <Input
                value={ghUsername}
                onChange={(e) => setGhUsername(e.target.value)}
                placeholder="your-github-login"
                autoComplete="off"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                HTTP Basic username for the git URL rewrite. Leave blank to use{" "}
                <code className="font-mono">x-access-token</code> (works with any PAT).
              </p>
            </div>
            <div className="space-y-1">
              <Label>
                Personal Access Token
                {ghEditTarget ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    (leave blank to keep existing)
                  </span>
                ) : null}
              </Label>
              <Input
                type="password"
                value={ghToken}
                onChange={(e) => {
                  setGhToken(e.target.value);
                  setGhTestStatus("idle");
                  setGhTestMsg("");
                }}
                placeholder={
                  ghEditTarget
                    ? "•••••• (blank = keep existing)"
                    : "ghp_… or github_pat_…"
                }
                autoComplete="new-password"
                className="font-mono"
              />
            </div>
            {ghTestStatus === "ok" && (
              <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                {ghTestMsg}
              </Badge>
            )}
            {ghTestStatus === "failed" && (
              <p className="whitespace-pre-wrap text-sm text-destructive">{ghTestMsg}</p>
            )}
            {ghSaveError && (
              <p className="whitespace-pre-wrap text-sm text-destructive">{ghSaveError}</p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="secondary"
              onClick={handleGhTest}
              disabled={!ghCanTest || ghTestStatus === "testing"}
            >
              {ghTestStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {ghTestStatus === "ok" && <Check className="mr-2 h-4 w-4 text-green-600" />}
              {ghTestStatus === "failed" && <X className="mr-2 h-4 w-4 text-destructive" />}
              {ghTestStatus === "testing" ? "Testing..." : "Test Token"}
            </Button>
            <Button onClick={handleGhSave} disabled={!ghCanSave}>
              {ghSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm remove a single Git credential */}
      <Dialog
        open={!!ghConfirmRemove}
        onOpenChange={(o) => { if (!o) setGhConfirmRemove(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Git credential?</DialogTitle>
            <DialogDescription>
              Removes <strong>{ghConfirmRemove?.name}</strong>. Jobs that
              pick this credential at submit time will fail to clone any
              private repo it was authorising. Other credentials on this
              cluster remain configured.
            </DialogDescription>
          </DialogHeader>
          {ghSaveError && (
            <p className="whitespace-pre-wrap text-sm text-destructive">{ghSaveError}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleGhRemove}>
              <Trash2 className="mr-2 h-4 w-4" />
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Tracker dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) resetForm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Experiment Tracker</DialogTitle>
            <DialogDescription>
              Submitted jobs get auto-linked to a tracker run. The SBATCH
              wrapper exports the backend-specific env vars
              (<code className="mx-1 font-mono">MLFLOW_TRACKING_URI</code> /{" "}
              <code className="font-mono">WANDB_API_KEY</code> etc.) so user
              code logs into the right run without any manual auth setup.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={newBackend === "wandb" ? "Team W&B" : "Team MLflow"}
              />
            </div>
            <div className="space-y-1">
              <Label>Backend</Label>
              <Select
                value={newBackend}
                onValueChange={(v) => {
                  setNewBackend(v as TrackerBackend);
                  // Sensible default tracking URI per backend, so the user
                  // doesn't have to know wandb's API endpoint. They can
                  // override for wandb-local.
                  if (v === "wandb") setNewUri("https://api.wandb.ai");
                  if (v === "mlflow") setNewUri("");
                  resetTest();
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mlflow">MLflow</SelectItem>
                  <SelectItem value="wandb">Weights &amp; Biases</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{newBackend === "wandb" ? "API host" : "Tracking URI"}</Label>
              <Input
                value={newUri}
                onChange={(e) => {
                  setNewUri(e.target.value);
                  resetTest();
                }}
                placeholder={
                  newBackend === "wandb"
                    ? "https://api.wandb.ai"
                    : "https://mlflow.internal"
                }
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {newBackend === "wandb"
                  ? "Leave as https://api.wandb.ai for SaaS, or point at a self-hosted wandb-local."
                  : "Self-hosted MLflow URL."}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>
                  {newBackend === "wandb"
                    ? "Entity (optional)"
                    : "Username (optional)"}
                </Label>
                <Input
                  value={newUsername}
                  onChange={(e) => {
                    setNewUsername(e.target.value);
                    resetTest();
                  }}
                  placeholder={
                    newBackend === "wandb" ? "your-team" : "user@example.com"
                  }
                  autoComplete="off"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label>
                  {newBackend === "wandb"
                    ? "API key"
                    : "Password / access key (optional)"}
                </Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    resetTest();
                  }}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  className="font-mono"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-1">
              {newBackend === "wandb" ? (
                <>
                  Get an API key from{" "}
                  <a
                    href="https://wandb.ai/authorize"
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    wandb.ai/authorize
                  </a>
                  . Exported into jobs as{" "}
                  <code className="font-mono">WANDB_API_KEY</code> /{" "}
                  <code className="font-mono">WANDB_ENTITY</code>; entity is
                  optional (W&amp;B uses the key&apos;s default entity when blank).
                </>
              ) : (
                <>
                  Sent as HTTP Basic auth to the MLflow server and exported into
                  jobs as <code className="font-mono">MLFLOW_TRACKING_USERNAME</code> /
                  <code className="font-mono">MLFLOW_TRACKING_PASSWORD</code>. Leave
                  blank for unauthenticated MLflow.
                </>
              )}
            </p>
            <div className="space-y-1">
              <Label>
                {newBackend === "wandb" ? "Default Project" : "Default Experiment Name"}
              </Label>
              <Input
                value={newDefaultExperiment}
                onChange={(e) => setNewDefaultExperiment(e.target.value)}
                placeholder="aura-jobs"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {newBackend === "wandb"
                  ? "Used when the submitter doesn't override per-job. W&B creates the project automatically on first run."
                  : "Used when the submitter doesn't override per-job. Created on the MLflow side if missing."}
              </p>
            </div>
            {testStatus === "ok" && (
              <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                {testMsg}
              </Badge>
            )}
            {testStatus === "failed" && (
              <p className="whitespace-pre-wrap text-sm text-destructive">{testMsg}</p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="secondary"
              onClick={handleTest}
              disabled={!canTest || testStatus === "testing"}
            >
              {testStatus === "testing" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {testStatus === "ok" && <Check className="mr-2 h-4 w-4 text-green-600" />}
              {testStatus === "failed" && <X className="mr-2 h-4 w-4 text-destructive" />}
              {testStatus === "testing" ? "Testing..." : "Test Connection"}
            </Button>
            <Button onClick={handleCreate} disabled={!canCreate}>
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add Tracker
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Tracker dialog */}
      <Dialog open={!!editTarget} onOpenChange={(o) => { if (!o) setEditTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Experiment Tracker</DialogTitle>
            <DialogDescription>
              Rotate credentials, change the experiment, or rename without
              dropping the tracker. Blank password = keep existing; use the
              <strong className="mx-1">Clear password</strong> toggle to
              remove it entirely.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Tracking URI</Label>
              <Input
                value={editUri}
                onChange={(e) => setEditUri(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>Username</Label>
                <Input
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value)}
                  placeholder="user@example.com"
                  autoComplete="off"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label>
                  Password / access key
                  {editTarget?.hasPassword ? (
                    <span className="ml-1 text-xs text-muted-foreground">(set)</span>
                  ) : null}
                </Label>
                <Input
                  type="password"
                  value={editPassword}
                  onChange={(e) => {
                    setEditPassword(e.target.value);
                    if (e.target.value.length > 0) setEditClearPassword(false);
                  }}
                  placeholder={editTarget?.hasPassword ? "•••••• (leave blank to keep)" : "—"}
                  autoComplete="new-password"
                  disabled={editClearPassword}
                  className="font-mono"
                />
              </div>
            </div>
            {editTarget?.hasPassword && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={editClearPassword}
                  onChange={(e) => {
                    setEditClearPassword(e.target.checked);
                    if (e.target.checked) setEditPassword("");
                  }}
                />
                Clear password (unauthenticate this tracker)
              </label>
            )}
            <div className="space-y-1">
              <Label>Default Experiment Name</Label>
              <Input
                value={editDefaultExperiment}
                onChange={(e) => setEditDefaultExperiment(e.target.value)}
                placeholder="aura-jobs"
                className="font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={saveEdit} disabled={savingEdit}>
              {savingEdit && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirmation */}
      <Dialog open={!!confirmRemove} onOpenChange={(o) => { if (!o) setConfirmRemove(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove tracker?</DialogTitle>
            <DialogDescription>
              Removes <strong>{confirmRemove?.name}</strong> from this cluster. Existing
              jobs already linked to this tracker keep their deep links but new jobs
              won&apos;t be auto-linked. The MLflow server itself is not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={doRemove}>
              <Trash2 className="mr-2 h-4 w-4" />
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
