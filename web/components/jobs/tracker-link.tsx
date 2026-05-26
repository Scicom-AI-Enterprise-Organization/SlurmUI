/**
 * Branded link to an experiment-tracker run (MLflow / W&B).
 *
 * Detects the backend from the URL host so callers don't have to pass
 * the tracker's backend separately — every place that renders the link
 * (job detail page, job-table list view, paged jobs) already has the
 * Job.experimentRunUrl in hand. URL-based detection keeps the DB shape
 * unchanged and self-corrects if a tracker is migrated from one host to
 * another later.
 *
 * Visual style:
 *   - MLflow → teal pill with the official "mountain peaks" mark
 *   - W&B    → amber pill with the yellow disc + bars mark
 *   - other  → neutral pill labelled "Tracker run" with a link icon
 */

import { ExternalLink } from "lucide-react";

type Variant = "mlflow" | "wandb" | "generic";

function detectVariant(url: string): Variant {
  try {
    const u = new URL(url);
    if (u.hostname === "wandb.ai" || u.hostname.endsWith(".wandb.ai")) return "wandb";
    // MLflow public-saas doesn't exist; everyone self-hosts. Hostname
    // alone isn't enough — match on the path pattern MLflow uses
    // (#/experiments/<id>/runs/<id>) or on a hostname literally
    // containing "mlflow".
    if (u.hostname.includes("mlflow") || /#\/experiments\//.test(u.hash + u.pathname)) {
      return "mlflow";
    }
  } catch {
    /* malformed URL → generic */
  }
  return "generic";
}

/** MLflow logomark — simplified two-peak silhouette. */
function MlflowIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
    >
      <path
        d="M3 20 L9 11 L13 16 L17 9 L21 20 Z"
        fill="currentColor"
      />
      <circle cx="9" cy="11" r="1.3" fill="currentColor" />
      <circle cx="17" cy="9" r="1.3" fill="currentColor" />
    </svg>
  );
}

/** W&B logomark — yellow disc with three vertical bars. */
function WandbIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
    >
      <circle cx="12" cy="12" r="10" fill="#FFCC33" />
      <g stroke="#1A1A1A" strokeWidth="2.2" strokeLinecap="round">
        <line x1="8.5" y1="16" x2="8.5" y2="9" />
        <line x1="12" y1="16" x2="12" y2="7" />
        <line x1="15.5" y1="16" x2="15.5" y2="11" />
      </g>
    </svg>
  );
}

const STYLES: Record<Variant, { className: string; title: string }> = {
  mlflow: {
    // MLflow brand is teal/cyan. Keep a subtle border + tinted bg so the
    // pill stands out without screaming.
    className:
      "inline-flex items-center gap-1 rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-xs font-medium text-cyan-700 hover:bg-cyan-500/20 dark:text-cyan-300",
    title: "Open this job's run on MLflow",
  },
  wandb: {
    className:
      "inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-500/20 dark:text-amber-300",
    title: "Open this job's run on Weights & Biases",
  },
  generic: {
    className:
      "inline-flex items-center gap-1 rounded border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700 hover:bg-violet-500/20 dark:text-violet-300",
    title: "Open this job's run in the experiment tracker",
  },
};

interface Props {
  url: string;
  /** Optional explicit override; otherwise inferred from `url`. */
  variant?: Variant;
  /** `size="sm"` for the table row (icon-only); default shows the label too. */
  size?: "sm" | "md";
}

export function TrackerLink({ url, variant, size = "md" }: Props) {
  const v = variant ?? detectVariant(url);
  const style = STYLES[v];
  const iconSizeClass = size === "sm" ? "h-3.5 w-3.5" : "h-3.5 w-3.5";
  const showLabel = size !== "sm";

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={style.className}
      title={style.title}
    >
      {v === "mlflow" && <MlflowIcon className={iconSizeClass} />}
      {v === "wandb" && <WandbIcon className={iconSizeClass} />}
      {v === "generic" && <ExternalLink className={iconSizeClass} />}
      {showLabel && (
        <span>
          {v === "mlflow" ? "MLflow" : v === "wandb" ? "W&B" : "Tracker"}
        </span>
      )}
      {showLabel && v !== "generic" && <ExternalLink className="h-3 w-3 opacity-60" />}
    </a>
  );
}
