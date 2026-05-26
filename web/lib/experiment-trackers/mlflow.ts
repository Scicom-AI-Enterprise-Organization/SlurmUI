/**
 * MLflow tracker adapter.
 *
 * Talks to the REST API at <trackingUri>/api/2.0/mlflow/*. We don't
 * bundle an MLflow SDK — the surface we need is small enough that a
 * handful of `fetch` calls is cheaper than another 50 MB of deps.
 *
 * Auth model (Phase 1): none, or basic-auth embedded in the URL
 * (`https://user:pass@mlflow.internal`). That covers the self-hosted
 * case which is the dominant deployment in research clusters; SaaS-style
 * auth (W&B / Comet) is Phase 2 and gets its own per-user credential
 * surface.
 */
import type {
  CreatedRun,
  ExperimentTracker,
  RunContext,
  TestConnectionResult,
  TrackerAdapter,
} from "./types";

// Trim trailing slash so we can blindly concat `/api/2.0/...`.
function baseUrl(tracker: ExperimentTracker): string {
  return tracker.trackingUri.replace(/\/+$/, "");
}

async function mlflowFetch(
  tracker: ExperimentTracker,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${baseUrl(tracker)}${path}`;
  // 10s timeout — the UI shows a spinner; we'd rather fail fast than hang.
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10_000);
  // Send basic auth when the tracker has credentials. Treat empty strings
  // as "unset" so a partially-filled form (user typed only the username)
  // doesn't generate a malformed Authorization header that the server
  // rejects with 401 — make the caller fix both fields explicitly.
  const u = (tracker.username ?? "").trim();
  const p = tracker.password ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (u.length > 0 && p.length > 0) {
    headers.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
  }
  // Caller-supplied headers override defaults. Cast `init.headers` to a
  // simple record since the union type with HeadersInit doesn't spread.
  Object.assign(headers, (init.headers ?? {}) as Record<string, string>);
  try {
    return await fetch(url, {
      ...init,
      headers,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

interface MlflowExperiment {
  experiment_id: string;
  name: string;
}

interface MlflowRun {
  info: {
    run_id: string;
    run_uuid: string;
    experiment_id: string;
    artifact_uri?: string;
  };
}

/** Resolve an experiment id by name; create it if missing. */
async function getOrCreateExperimentId(
  tracker: ExperimentTracker,
  name: string,
): Promise<string> {
  // get-by-name returns 200 with the experiment, or 404 RESOURCE_DOES_NOT_EXIST.
  const getRes = await mlflowFetch(
    tracker,
    `/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(name)}`,
  );
  if (getRes.ok) {
    const data = (await getRes.json()) as { experiment: MlflowExperiment };
    return data.experiment.experiment_id;
  }
  // Not 404? Surface the body so the caller can render a helpful error.
  if (getRes.status !== 404) {
    const body = await getRes.text().catch(() => "");
    throw new Error(`MLflow get experiment failed (HTTP ${getRes.status}): ${body.slice(0, 300)}`);
  }
  // Create — POST /api/2.0/mlflow/experiments/create
  const createRes = await mlflowFetch(tracker, "/api/2.0/mlflow/experiments/create", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    throw new Error(`MLflow create experiment failed (HTTP ${createRes.status}): ${body.slice(0, 300)}`);
  }
  const data = (await createRes.json()) as { experiment_id: string };
  return data.experiment_id;
}

export const mlflowAdapter: TrackerAdapter = {
  backend: "mlflow",

  async testConnection(tracker) {
    if (!tracker.trackingUri || !/^https?:\/\//i.test(tracker.trackingUri)) {
      return { ok: false, detail: "Tracking URI must start with http:// or https://" };
    }
    try {
      // search returns 200 even on empty servers, so it's a good shape check.
      // We POST with an empty filter; the server responds with { experiments: [...] }.
      const res = await mlflowFetch(tracker, "/api/2.0/mlflow/experiments/search", {
        method: "POST",
        body: JSON.stringify({ max_results: 1 }),
      });
      if (res.ok) {
        return { ok: true, detail: `Connected to ${tracker.trackingUri}` };
      }
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          detail: `Authentication required (HTTP ${res.status}). Embed basic-auth credentials in the URL: https://user:pass@host.`,
        };
      }
      const body = await res.text().catch(() => "");
      return { ok: false, detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("aborted")) {
        return { ok: false, detail: "Connection timed out after 10s" };
      }
      return { ok: false, detail: `Cannot reach server: ${msg}` };
    }
  },

  async createRun(tracker, ctx) {
    const experimentName = ctx.experimentName || tracker.defaultExperimentName || "aura-jobs";
    const experimentId = await getOrCreateExperimentId(tracker, experimentName);

    // Standard MLflow tags so runs are discoverable from the tracker side
    // regardless of how the user instruments their code. mlflow.runName is
    // the magic key MLflow's UI reads for the run display name.
    const tags: Array<{ key: string; value: string }> = [
      { key: "mlflow.source.type", value: "JOB" },
      { key: "mlflow.source.name", value: `aura/${ctx.clusterId}/${ctx.jobId}` },
      { key: "aura.job_id", value: ctx.jobId },
      { key: "aura.cluster_id", value: ctx.clusterId },
    ];
    if (ctx.runName) tags.push({ key: "mlflow.runName", value: ctx.runName });
    if (ctx.clusterName) tags.push({ key: "aura.cluster_name", value: ctx.clusterName });
    if (ctx.userEmail) tags.push({ key: "aura.user", value: ctx.userEmail });
    if (ctx.unixUsername) tags.push({ key: "aura.unix_username", value: ctx.unixUsername });

    const createRes = await mlflowFetch(tracker, "/api/2.0/mlflow/runs/create", {
      method: "POST",
      body: JSON.stringify({
        experiment_id: experimentId,
        start_time: Date.now(),
        tags,
      }),
    });
    if (!createRes.ok) {
      const body = await createRes.text().catch(() => "");
      throw new Error(`MLflow create run failed (HTTP ${createRes.status}): ${body.slice(0, 300)}`);
    }
    const data = (await createRes.json()) as { run: MlflowRun };
    const runId = data.run.info.run_id;
    return {
      runId,
      runUrl: deepLinkInternal(tracker, runId, experimentId),
      extra: { experimentId, experimentName },
    };
  },

  preStartShell(tracker, run, ctx) {
    // Everything `export`ed here is visible to the user's job script. We
    // also stamp the slurm_job_id tag from inside the job (only $SLURM_JOB_ID
    // is known by then); failure is swallowed so a flaky tracker can't crash
    // the job.
    // The MLflow Python client reads MLFLOW_TRACKING_USERNAME +
    // MLFLOW_TRACKING_PASSWORD env vars and sends them as Basic auth on
    // every request. Username is non-secret and stays inline; password
    // is moved to the per-job secrets file (see PreStartShellResult).
    const u = (tracker.username ?? "").trim();
    const p = tracker.password ?? "";
    const hasCreds = u.length > 0 && p.length > 0;
    const lines: string[] = [
      "# --- aura: experiment tracker (MLflow) prelude ---",
      `export MLFLOW_TRACKING_URI=${shellQuote(tracker.trackingUri)}`,
      `export MLFLOW_EXPERIMENT_NAME=${shellQuote(ctx.experimentName || tracker.defaultExperimentName || "aura-jobs")}`,
      `export MLFLOW_RUN_ID=${shellQuote(run.runId)}`,
      `export AURA_EXPERIMENT_TRACKER_URL=${shellQuote(run.runUrl)}`,
      ...(hasCreds ? [
        `export MLFLOW_TRACKING_USERNAME=${shellQuote(u)}`,
        // PASSWORD intentionally NOT inlined here — submit-job sources it
        // from /tmp/.aura-secrets-<jobid>.env (mode 0600 owned by user).
        // Keeps the secret out of the job script body and out of
        // slurmdbd's stored copy of the script.
      ] : []),
      // Stamp slurm_job_id as soon as Slurm assigns one. mlflow CLI is the
      // simplest path; if the user's env doesn't have it, the tag just
      // doesn't get set — non-fatal.
      "if command -v mlflow >/dev/null 2>&1 && [ -n \"${SLURM_JOB_ID:-}\" ]; then",
      "  mlflow runs set-tag --run-id \"$MLFLOW_RUN_ID\" slurm_job_id \"$SLURM_JOB_ID\" >/dev/null 2>&1 || true",
      "fi",
      "# --- end aura prelude ---",
      "",
    ];
    const secrets: Record<string, string> = {};
    if (hasCreds) secrets.MLFLOW_TRACKING_PASSWORD = p;
    return { script: lines.join("\n"), secrets };
  },

  deepLink(tracker, runId, extra) {
    const experimentId = extra?.experimentId as string | undefined;
    return deepLinkInternal(tracker, runId, experimentId);
  },
};

function deepLinkInternal(
  tracker: ExperimentTracker,
  runId: string,
  experimentId: string | undefined,
): string {
  // MLflow's web UI uses hash-routing.
  if (experimentId) {
    return `${baseUrl(tracker)}/#/experiments/${experimentId}/runs/${runId}`;
  }
  // Without the experiment id we fall back to a search URL the user can
  // resolve in one click.
  return `${baseUrl(tracker)}/#/experiments/0/runs/${runId}`;
}

/**
 * Quote a value for single-line bash export. Single-quotes safely escape
 * everything except single-quotes themselves, which we replace with the
 * `'\''` close-reopen idiom.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
