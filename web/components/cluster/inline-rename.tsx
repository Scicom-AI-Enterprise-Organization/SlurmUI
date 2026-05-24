"use client";

/**
 * Inline cluster-name editor for the cluster detail header.
 *
 * Shows the name as a normal heading with a pencil icon next to it.
 * Click pencil → swap to an input + Save / Cancel buttons. Saves via
 * PATCH /api/clusters/[id] (which the backend already supports for
 * `{ name }`) and refreshes server components so the rest of the UI
 * picks up the new name without a hard reload.
 *
 * Errors (e.g. 409 on a duplicate name) render inline under the input.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Check, X, Loader2 } from "lucide-react";

interface InlineRenameProps {
  clusterId: string;
  initialName: string;
}

export function InlineRename({ clusterId, initialName }: InlineRenameProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState(initialName);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cancel = () => {
    setDraft(name);
    setErr(null);
    setEditing(false);
  };

  const save = async () => {
    const next = draft.trim();
    if (!next || next === name) { cancel(); return; }
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch(`/api/clusters/${clusterId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setErr(body.error ?? `HTTP ${r.status}`);
        return;
      }
      setName(next);
      setEditing(false);
      // Refresh the server-rendered header / breadcrumbs / cluster list
      // so the new name propagates without a full page reload.
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <h1 className="text-3xl font-bold">{name}</h1>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Rename cluster"
          title="Rename cluster"
        >
          <Pencil className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setErr(null); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            else if (e.key === "Escape") cancel();
          }}
          disabled={saving}
          maxLength={64}
          className="border-input bg-background min-w-0 rounded-md border px-3 text-3xl font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ width: `${Math.max(draft.length + 2, 8)}ch` }}
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || !draft.trim() || draft.trim() === name}
          className="rounded-md p-1.5 text-green-600 hover:bg-muted disabled:opacity-40 dark:text-green-400"
          aria-label="Save name"
          title="Save"
        >
          {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          className="rounded-md p-1.5 text-red-600 hover:bg-muted disabled:opacity-40 dark:text-red-400"
          aria-label="Cancel rename"
          title="Cancel"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      {err && <span className="text-xs text-red-600 dark:text-red-400">{err}</span>}
    </div>
  );
}
