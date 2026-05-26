/**
 * Weights & Biases adapter.
 *
 * Field mapping (reuses the generic ExperimentTracker shape):
 *   - trackingUri          → wandb host (default https://api.wandb.ai)
 *   - username             → wandb entity (user or team) — optional; when
 *                            blank, wandb falls back to the API key's owner
 *   - password             → wandb API key  (https://wandb.ai/authorize)
 *   - defaultExperimentName → wandb project
 *
 * Run lifecycle: we DON'T pre-create the run on wandb's side. Instead we
 * generate a stable run id (UUIDv4 without dashes; matches wandb's id
 * format) and pass it via $WANDB_RUN_ID. The user's wandb.init() picks
 * up the env var and uses our id — so the link we stamp on the Aura Job
 * row matches the actual wandb run that ends up in the project.
 *
 * Why no pre-create: wandb's REST "/api/v1/runs" endpoint exists but is
 * unofficial; the supported path is via the wandb SDK (wandb.init).
 * Generating the id client-side gives us deep-link parity without
 * tying Aura to a private API surface.
 */
import { randomUUID } from "crypto";
import type {
  CreatedRun,
  ExperimentTracker,
  RunContext,
  TestConnectionResult,
  TrackerAdapter,
} from "./types";

function baseUrl(tracker: ExperimentTracker): string {
  // Strip a trailing slash if the admin pasted one — keeps the URLs we
  // build below from accumulating "//".
  return (tracker.trackingUri || "https://api.wandb.ai").replace(/\/+$/, "");
}

/**
 * wandb's public auth pattern is HTTP Basic with username "api" and the
 * API key as the password. Same header the wandb Python SDK sends.
 */
function authHeader(tracker: ExperimentTracker): Record<string, string> {
  const key = tracker.password ?? "";
  if (!key) return {};
  const b64 = Buffer.from(`api:${key}`).toString("base64");
  return { Authorization: `Basic ${b64}` };
}

async function wandbGraphql(
  tracker: ExperimentTracker,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Response> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10_000);
  try {
    return await fetch(`${baseUrl(tracker)}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(tracker),
      },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function shellQuote(s: string): string {
  // Same single-quote escape pattern as mlflow.ts — wraps the value in
  // '…' and escapes any embedded ' as '\''. wandb keys are alphanumeric
  // so this is defensive, but it's correct for any string.
  return `'${(s ?? "").replace(/'/g, "'\\''")}'`;
}

/**
 * The public hostname of wandb (where humans go to view runs) is
 * https://wandb.ai/, even when the API host is https://api.wandb.ai.
 * Self-hosted W&B (wandb-local) typically serves both API and UI on
 * the same host, so we only swap the api.* prefix.
 */
function webUiBase(tracker: ExperimentTracker): string {
  const u = baseUrl(tracker);
  return u.replace(/^https?:\/\/api\./, (m) => m.replace("api.", ""));
}

export const wandbAdapter: TrackerAdapter = {
  backend: "wandb",

  async testConnection(tracker): Promise<TestConnectionResult> {
    if (!tracker.password) {
      return { ok: false, detail: "API key is required for W&B." };
    }
    try {
      const res = await wandbGraphql(tracker, `{ viewer { username entity } }`);
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `Auth failed (HTTP ${res.status}). Check the API key.` };
      }
      if (!res.ok) {
        return { ok: false, detail: `HTTP ${res.status} from ${baseUrl(tracker)}/graphql` };
      }
      const data = (await res.json()) as {
        data?: { viewer?: { username?: string; entity?: string } };
        errors?: Array<{ message?: string }>;
      };
      const err = data.errors?.[0]?.message;
      if (err) return { ok: false, detail: `wandb error: ${err}` };
      const v = data.data?.viewer;
      if (!v?.username) {
        return { ok: false, detail: "wandb did not return a viewer — key may be invalid." };
      }
      return {
        ok: true,
        detail: `Authenticated as ${v.username}${v.entity ? ` (default entity: ${v.entity})` : ""}`,
      };
    } catch (e) {
      return {
        ok: false,
        detail: e instanceof Error ? e.message : "Network error reaching wandb",
      };
    }
  },

  async createRun(tracker, ctx: RunContext): Promise<CreatedRun> {
    // wandb run ids are typically 8-char base36 but accept any string that
    // matches /^[A-Za-z0-9_-]+$/. UUID-without-dashes is safely in that
    // range and gives us a globally-unique id we can stamp on the Aura
    // Job before the slurm script runs.
    const runId = randomUUID().replace(/-/g, "");
    const entity = (tracker.username ?? "").trim();
    const project = ctx.experimentName || tracker.defaultExperimentName || "aura-jobs";
    const url = entity
      ? `${webUiBase(tracker)}/${entity}/${project}/runs/${runId}`
      : `${webUiBase(tracker)}/home`; // fallback when no entity yet (resolves at login)
    return {
      runId,
      runUrl: url,
      extra: { entity, project },
    };
  },

  preStartShell(tracker, run, ctx) {
    const key = tracker.password ?? "";
    const entity = (tracker.username ?? "").trim();
    const project = ctx.experimentName || tracker.defaultExperimentName || "aura-jobs";
    const runName = ctx.runName ?? "";
    const lines: string[] = [
      "# --- aura: experiment tracker (W&B) prelude ---",
      // Disable wandb's interactive login flow — jobs run headless. If the
      // key is missing wandb.init() will error out instead of prompting.
      `export WANDB_MODE=online`,
      `export WANDB_PROJECT=${shellQuote(project)}`,
      `export WANDB_RUN_ID=${shellQuote(run.runId)}`,
      `export AURA_EXPERIMENT_TRACKER_URL=${shellQuote(run.runUrl)}`,
    ];
    if (entity) lines.push(`export WANDB_ENTITY=${shellQuote(entity)}`);
    if (runName) lines.push(`export WANDB_NAME=${shellQuote(runName)}`);
    // API key intentionally moved to the secrets channel (see
    // PreStartShellResult). Stays out of the job script body.
    // Point WANDB_BASE_URL at a self-hosted W&B if the cluster admin
    // configured one — wandb-local installations need this set to find
    // their backend. URL is non-secret.
    const base = baseUrl(tracker);
    if (base && base !== "https://api.wandb.ai") {
      lines.push(`export WANDB_BASE_URL=${shellQuote(base)}`);
    }
    lines.push("# --- end aura prelude ---", "");
    const secrets: Record<string, string> = {};
    if (key) secrets.WANDB_API_KEY = key;
    return { script: lines.join("\n"), secrets };
  },

  deepLink(tracker, runId, extra) {
    const entity = (extra?.entity as string | undefined) ?? "";
    const project = (extra?.project as string | undefined) ?? tracker.defaultExperimentName ?? "";
    if (entity && project) {
      return `${webUiBase(tracker)}/${entity}/${project}/runs/${runId}`;
    }
    // Without the entity/project pair we can't build a direct run URL;
    // best effort is the wandb home page where the user can search.
    return `${webUiBase(tracker)}/home`;
  },
};
