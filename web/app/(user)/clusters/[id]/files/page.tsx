"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
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
  const clusterId = params.id as string;

  const [path, setPath] = useState("");
  const [rootId, setRootId] = useState("home");
  const [roots, setRoots] = useState<Array<{ id: string; label: string; base: string; type: string }>>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);

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
    } catch (e: any) {
      toast.error(e.message ?? "Failed to list files");
    } finally {
      setLoading(false);
    }
  }, [clusterId]);

  useEffect(() => { load("", "home"); }, [load]);

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
            Browse {activeRoot ? activeRoot.label : "your storage"} (read-only)
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
                        onClick={() => entry.is_dir && navigate(entry)}
                        className={`flex items-center gap-2 ${entry.is_dir ? "cursor-pointer hover:underline" : "cursor-default"}`}
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
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => download(entry)}
                          disabled={downloading === filePath}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
