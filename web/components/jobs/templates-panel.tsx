"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Play, Plus, Pencil, Trash2, Loader2, FileText } from "lucide-react";

interface Template {
  id: string;
  name: string;
  description: string | null;
  script: string;
  partition: string;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  clusterId: string;
}

export function TemplatesPanel({ clusterId }: Props) {
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formScript, setFormScript] = useState("");
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState<Template | null>(null);

  // Error dialog (replaces toast)
  const [errorDialog, setErrorDialog] = useState<{ title: string; message: string } | null>(null);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/templates`).then((r) => r.json());
      setTemplates(res.templates ?? []);
    } catch {
      // Fall through — an empty list is fine for a brand-new cluster.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  const openCreate = () => {
    setEditing(null);
    setFormName("");
    setFormDescription("");
    setFormScript("");
    setEditOpen(true);
  };

  const openEdit = (t: Template) => {
    setEditing(t);
    setFormName(t.name);
    setFormDescription(t.description ?? "");
    setFormScript(t.script);
    setEditOpen(true);
  };

  const handleSave = async () => {
    const name = formName.trim();
    const script = formScript.trim();
    if (!name || !script) {
      setErrorDialog({ title: "Missing fields", message: "Name and script are required." });
      return;
    }
    if (!/#SBATCH\s+(?:--partition|-p)[=\s]+\S+/.test(script)) {
      setErrorDialog({
        title: "Missing partition",
        message: "Script must contain a #SBATCH --partition=<name> directive so the template knows which partition to submit to.",
      });
      return;
    }
    setSaving(true);
    try {
      const url = editing
        ? `/api/clusters/${clusterId}/templates/${editing.id}`
        : `/api/clusters/${clusterId}/templates`;
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: formDescription, script }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setErrorDialog({ title: "Failed to save", message: err.error ?? `Server returned ${res.status}` });
        return;
      }
      setEditOpen(false);
      fetchAll();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const res = await fetch(`/api/clusters/${clusterId}/templates/${confirmDelete.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setErrorDialog({ title: "Failed to delete", message: err.error ?? `Server returned ${res.status}` });
    }
    setConfirmDelete(null);
    fetchAll();
  };

  const handleRun = async (t: Template) => {
    setRunning(t.id);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/templates/${t.id}/run`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok || res.status === 201) {
        router.push(`/clusters/${clusterId}/jobs/${body.id}`);
      } else {
        setErrorDialog({ title: "Failed to run template", message: body.error ?? `Server returned ${res.status}` });
      }
    } finally {
      setRunning(null);
    }
  };

  if (loading) {
    return <p className="text-center text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          New Template
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <FileText className="mb-2 h-8 w-8" />
            <p>No templates yet.</p>
            <p className="text-xs mt-1">Save a reusable job script and re-run it anytime with one click.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Partition</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-[180px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="font-mono text-xs">{t.partition}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t.description || <span className="italic">—</span>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(t.updatedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Run now"
                      onClick={() => handleRun(t)}
                      disabled={running === t.id}
                    >
                      {running === t.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 text-green-600" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Edit"
                      onClick={() => openEdit(t)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Delete"
                      className="text-destructive"
                      onClick={() => setConfirmDelete(t)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit template: ${editing.name}` : "New Template"}</DialogTitle>
            <DialogDescription>
              Save a reusable sbatch script. Clicking <strong>Run</strong> later submits it as a new job.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                placeholder="e.g. train-llama-7b"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tpl-description">Description (optional)</Label>
              <Input
                id="tpl-description"
                placeholder="Short note so you remember what this does"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tpl-script">Script</Label>
              <Textarea
                id="tpl-script"
                rows={16}
                className="font-mono text-sm"
                placeholder={"#!/bin/bash\n#SBATCH --job-name=my-job\n#SBATCH --nodes=1\n\nyour command here"}
                value={formScript}
                onChange={(e) => setFormScript(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete template?</DialogTitle>
            <DialogDescription>
              Remove <strong>{confirmDelete?.name}</strong>. Jobs already submitted from it are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Keep</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleDelete}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Error dialog (replaces toast) */}
      <Dialog open={!!errorDialog} onOpenChange={(o) => { if (!o) setErrorDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">{errorDialog?.title}</DialogTitle>
            <DialogDescription>{errorDialog?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setErrorDialog(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
