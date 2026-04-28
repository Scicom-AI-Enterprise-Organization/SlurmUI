"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Lightbulb, Wrench } from "lucide-react";
import { explainSlurmError, type ExplainContext, type ExplainMatch } from "@/lib/slurm-error-explain";
import { cn } from "@/lib/utils";

interface Props {
  // Anything text that might mention the failure: stderr, stdout tail,
  // info-tab dump, etc. Nulls/undefineds are filtered out.
  texts: Array<string | null | undefined>;
  ctx?: ExplainContext;
  // When true, show even when nothing matched (for ?explain debugging).
  // Otherwise the component renders nothing on no-match.
  showEmpty?: boolean;
}

/**
 * Plain-English explainer for common Slurm / GPU / NCCL / OOM failures.
 * Pattern dictionary lives in `web/lib/slurm-error-explain.ts`.
 *
 * Renders a collapsible card with one row per detected pattern. Hidden
 * entirely when nothing matches (unless `showEmpty`), so it stays out of
 * the way on healthy jobs.
 */
export function ErrorExplainer({ texts, ctx, showEmpty = false }: Props) {
  const matches = useMemo<ExplainMatch[]>(() => explainSlurmError(texts, ctx ?? {}), [texts, ctx]);
  const [open, setOpen] = useState(true);

  if (matches.length === 0 && !showEmpty) return null;

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-amber-900 dark:text-amber-100"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Lightbulb className="h-4 w-4" />
        <span>
          Likely cause{matches.length > 1 ? "s" : ""}
          <span className="ml-1 text-xs font-normal text-amber-700 dark:text-amber-300">
            ({matches.length} pattern{matches.length === 1 ? "" : "s"} matched)
          </span>
        </span>
      </button>
      {open && (
        <ul className="space-y-3 border-t border-amber-200 px-4 py-3 dark:border-amber-900/60">
          {matches.length === 0 && (
            <li className="text-xs text-amber-800 dark:text-amber-200">
              No known patterns matched — read the Stderr / Output tabs directly.
            </li>
          )}
          {matches.map((m) => (
            <li key={m.id} className="space-y-1 text-sm">
              <div className="flex items-start gap-2">
                <span
                  className={cn(
                    "mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    m.kind === "fix"
                      ? "bg-amber-200 text-amber-900 dark:bg-amber-800/40 dark:text-amber-100"
                      : "bg-rose-200 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100",
                  )}
                >
                  {m.kind === "fix" ? "user fix" : "ops"}
                </span>
                <span className="text-amber-900 dark:text-amber-100">{m.summary}</span>
              </div>
              <p className="ml-9 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200">
                <Wrench className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{m.suggestion}</span>
              </p>
              {m.evidence && (
                <pre className="ml-9 max-w-full overflow-x-auto rounded bg-amber-100/60 px-2 py-1 text-[11px] text-amber-900/80 dark:bg-amber-900/30 dark:text-amber-200/80">
                  {m.evidence}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
