"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CodeEditor } from "@/components/ui/code-editor";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Folder, File, Download, ArrowLeft, RefreshCw, ChevronRight, Home,
  FilePlus, Upload, Loader2, Save,
} from "lucide-react";

interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: string;
  mode: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

export default function FilesPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const clusterId = params.id as string;

  const [path, setPath] = useState(() => searchParams.get("path") ?? "");
  const [rootId, setRootId] = useState(() => searchParams.get("root") ?? "home");
  const [roots, setRoots] = useState<Array<{ id: string; label: string; base: string; type: string }>>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);

  // New-file / edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editPath, setEditPath] = useState(""); // relative under root
  const [editIsNew, setEditIsNew] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // Timestamp of the most recent successful save — used to show a brief
  // "Saved" indicator without closing the dialog (so Ctrl/Cmd+S keeps you
  // in the editor instead of yanking you back to the file list).
  const [editSavedAt, setEditSavedAt] = useState<number | null>(null);

  // Upload
  const [uploading, setUploading] = useState(false);

  // Single source of truth for URL state — every navigation / dialog change
  // funnels through here so refresh + share + browser-back stay consistent.
  const writeUrlState = useCallback((opts: {
    path: string;
    root: string;
    edit?: string | null;
    isNew?: boolean;
  }) => {
    const qs = new URLSearchParams();
    if (opts.root && opts.root !== "home") qs.set("root", opts.root);
    if (opts.path) qs.set("path", opts.path);
    if (opts.edit) qs.set("edit", opts.edit);
    if (opts.isNew) qs.set("new", "1");
    const search = qs.toString();
    router.replace(
      `/clusters/${clusterId}/files${search ? `?${search}` : ""}`,
      { scroll: false },
    );
  }, [clusterId, router]);

  const load = useCallback(async (p: string, r: string) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ path: p, root: r }).toString();
      const res = await fetch(`/api/clusters/${clusterId}/files?${qs}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to list files" }));
        throw new Error(err.error);
      }
      const data = await res.json();
      setEntries(data.entries ?? []);
      setRoots(data.roots ?? []);
      setPath(p);
      setRootId(r);
      writeUrlState({ path: p, root: r });
    } catch (e: any) {
      toast.error(e.message ?? "Failed to list files");
    } finally {
      setLoading(false);
    }
  }, [clusterId, writeUrlState]);

  // Open an edit dialog for an arbitrary path (used both by row clicks and
  // by the on-mount URL restorer below).
  const openEditByPath = useCallback(async (filePath: string, r: string) => {
    setEditPath(filePath);
    setEditIsNew(false);
    setEditContent("");
    setEditLoading(true);
    setEditOpen(true);
    try {
      const qs = new URLSearchParams({ path: filePath, root: r }).toString();
      const res = await fetch(`/api/clusters/${clusterId}/files/download?${qs}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error ?? "Failed to open file");
        setEditOpen(false);
        return;
      }
      const blob = await res.blob();
      const text = await blob.text();
      setEditContent(text);
    } catch {
      toast.error("Failed to open file");
      setEditOpen(false);
    } finally {
      setEditLoading(false);
    }
  }, [clusterId]);

  useEffect(() => {
    const initPath = searchParams.get("path") ?? "";
    const initRoot = searchParams.get("root") ?? "home";
    const editParam = searchParams.get("edit");
    const newParam = searchParams.get("new") === "1";
    load(initPath, initRoot);
    if (newParam) {
      setEditPath(editParam ?? (initPath ? `${initPath}/new-file.txt` : "new-file.txt"));
      setEditIsNew(true);
      setEditContent("");
      setEditOpen(true);
    } else if (editParam) {
      openEditByPath(editParam, initRoot);
    }
    // Run only once on mount — subsequent URL changes flow back via load().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeRoot = roots.find((r) => r.id === rootId);

  const navigate = (entry: FileEntry) => {
    if (!entry.is_dir) return;
    const next = path ? `${path}/${entry.name}` : entry.name;
    load(next, rootId);
  };

  const goUp = () => {
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    load(parts.join("/"), rootId);
  };

  const download = async (entry: FileEntry) => {
    const filePath = path ? `${path}/${entry.name}` : entry.name;
    setDownloading(filePath);
    try {
      const qs = new URLSearchParams({ path: filePath, root: rootId }).toString();
      const res = await fetch(`/api/clusters/${clusterId}/files/download?${qs}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Download failed" }));
        throw new Error(err.error);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(e.message ?? "Download failed");
    } finally {
      setDownloading(null);
    }
  };

  const openNewFile = () => {
    const suggested = path ? `${path}/new-file.txt` : "new-file.txt";
    setEditPath(suggested);
    setEditIsNew(true);
    setEditContent("");
    setEditOpen(true);
    writeUrlState({ path, root: rootId, edit: suggested, isNew: true });
  };

  const openEditFile = (entry: FileEntry) => {
    const filePath = path ? `${path}/${entry.name}` : entry.name;
    writeUrlState({ path, root: rootId, edit: filePath });
    openEditByPath(filePath, rootId);
  };

  const closeEditDialog = () => {
    setEditOpen(false);
    setEditError(null);
    setEditSavedAt(null);
    // Refresh the directory listing now that we're back in the file browser —
    // catches any size/timestamp updates from the in-dialog saves we kept
    // silent. writeUrlState happens inside load(), so don't double up here.
    load(path, rootId);
  };

  const saveFile = async () => {
    if (!editPath.trim()) {
      setEditError("Path is required");
      return;
    }
    setEditError(null);
    setEditSaving(true);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/files/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: editPath, root: rootId, content: editContent }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Show inline in the dialog instead of a toast — the user is staring
        // at the editor, the error belongs next to it, and toasts disappear
        // before they can read a long stderr trace.
        setEditError(err.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      // Stay in the editor on success. Closing on every save makes Ctrl/Cmd+S
      // a destructive shortcut — users save mid-edit and lose their place.
      // The directory listing is mildly stale (file size/timestamp) but
      // refreshes the next time they navigate.
      setEditError(null);
      setEditSavedAt(Date.now());
      // If this was a "new file" save, flip out of new-file mode so the
      // dialog title and footer button switch from Create → Save.
      if (editIsNew) {
        setEditIsNew(false);
      }
    } catch (e) {
      setEditError(`Save request failed: ${(e as Error).message}`);
    } finally {
      setEditSaving(false);
    }
  };

  const uploadFiles = async (files: FileList) => {
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const buf = await f.arrayBuffer();
        // Browser-safe base64 (Buffer isn't available in the client bundle).
        let bin = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
        const b64 = btoa(bin);
        const relPath = path ? `${path}/${f.name}` : f.name;
        const res = await fetch(`/api/clusters/${clusterId}/files/write`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: relPath, root: rootId, base64: b64 }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          toast.error(`Upload ${f.name} failed: ${err.error ?? ""}`);
        }
      }
      load(path, rootId);
    } finally {
      setUploading(false);
    }
  };

  // Breadcrumb parts
  const breadcrumbs = path ? path.split("/").filter(Boolean) : [];

  const sorted = [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Files</h1>
          <p className="text-muted-foreground">
            Browse {activeRoot ? activeRoot.label : "your storage"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {roots.length > 1 && (
            <Select
              value={rootId}
              onValueChange={(v) => { if (v) load("", v); }}
            >
              <SelectTrigger className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roots.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" size="sm" onClick={openNewFile}>
            <FilePlus className="mr-2 h-4 w-4" /> New file
          </Button>
          <Button variant="outline" size="sm" asChild disabled={uploading}>
            <label className="cursor-pointer">
              {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              {uploading ? "Uploading..." : "Upload"}
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) uploadFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </Button>
          <Button variant="outline" size="sm" onClick={() => load(path, rootId)}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-sm">
        <button
          onClick={() => load("", rootId)}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <Home className="h-3.5 w-3.5" /> Home
        </button>
        {breadcrumbs.map((part, i) => {
          const crumbPath = breadcrumbs.slice(0, i + 1).join("/");
          return (
            <span key={crumbPath} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <button
                onClick={() => load(crumbPath, rootId)}
                className="text-muted-foreground hover:text-foreground"
              >
                {part}
              </button>
            </span>
          );
        })}
      </div>

      {/* Back button */}
      {path && (
        <Button variant="ghost" size="sm" onClick={goUp}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
      )}

      {loading ? (
        <p className="text-center text-muted-foreground py-12">Loading...</p>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-muted-foreground">
          <Folder className="mb-2 h-8 w-8" />
          <p>This directory is empty.</p>
        </div>
      ) : (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Size</th>
                <th className="px-4 py-2 text-left font-medium">Modified</th>
                <th className="px-4 py-2 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => {
                const filePath = path ? `${path}/${entry.name}` : entry.name;
                return (
                  <tr key={entry.name} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => {
                          if (entry.is_dir) navigate(entry);
                          else if (entry.size <= 5 * 1024 * 1024) openEditFile(entry);
                        }}
                        disabled={!entry.is_dir && entry.size > 5 * 1024 * 1024}
                        title={
                          entry.is_dir
                            ? "Open folder"
                            : entry.size > 5 * 1024 * 1024
                              ? "File too large to edit (download instead)"
                              : "Edit file"
                        }
                        className="flex items-center gap-2 cursor-pointer hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
                      >
                        {entry.is_dir
                          ? <Folder className="h-4 w-4 text-blue-500 shrink-0" />
                          : <File className="h-4 w-4 text-muted-foreground shrink-0" />}
                        <span className={entry.is_dir ? "font-medium" : ""}>{entry.name}</span>
                      </button>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {entry.is_dir ? "—" : formatSize(entry.size)}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {new Date(entry.modified).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {!entry.is_dir && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Download"
                            onClick={() => download(entry)}
                            disabled={downloading === filePath}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* New / edit file dialog */}
      <Dialog
        open={editOpen}
        onOpenChange={(o) => {
          if (editSaving) return;
          if (o) setEditOpen(true);
          else closeEditDialog();
        }}
      >
        <DialogContent className="flex h-[92vh] max-h-[92vh] w-[95vw] max-w-[1400px] flex-col">
          <DialogHeader>
            <DialogTitle>{editIsNew ? "New file" : `Edit ${editPath.split("/").pop()}`}</DialogTitle>
            <DialogDescription>
              {editIsNew
                ? "Path is relative to the selected root."
                : `Saving to ${editPath} — press ⌘/Ctrl+S to save`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col space-y-3">
            {editIsNew && (
              <div className="space-y-1">
                <Label htmlFor="file-path">Path</Label>
                <Input
                  id="file-path"
                  value={editPath}
                  onChange={(e) => setEditPath(e.target.value)}
                  placeholder="scripts/train.sh"
                  autoFocus
                />
              </div>
            )}
            {editLoading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading file...
              </div>
            ) : (
              <CodeEditor
                className="min-h-0 flex-1 overflow-hidden rounded-md border"
                value={editContent}
                onChange={(v) => {
                  setEditContent(v);
                  // First keystroke after a successful save invalidates the
                  // "Saved at HH:MM:SS" indicator — the file no longer
                  // matches what's on disk.
                  if (editSavedAt) setEditSavedAt(null);
                  if (editError) setEditError(null);
                }}
                filename={editPath}
                onSave={saveFile}
                fontSize={12}
                placeholder={editIsNew ? "#!/bin/bash\n# your script" : ""}
              />
            )}
          </div>
          {editError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">
              <div className="mb-1 font-medium text-destructive">Save failed</div>
              <pre className="whitespace-pre-wrap break-words font-mono text-destructive">
                {editError}
              </pre>
            </div>
          )}
          <DialogFooter className="items-center">
            {editSavedAt && !editSaving && !editError && (
              <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <Save className="h-3 w-3" />
                Saved at {new Date(editSavedAt).toLocaleTimeString()}
              </span>
            )}
            <DialogClose asChild>
              <Button variant="outline" disabled={editSaving}>Close</Button>
            </DialogClose>
            <Button onClick={saveFile} disabled={editSaving || editLoading}>
              {editSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {editSaving ? "Saving..." : (editIsNew ? "Create" : "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
