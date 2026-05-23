/**
 * Experiment-tracker abstraction shared across MLflow / W&B / Comet.
 *
 * Phase 1 ships the MLflow adapter only; W&B and Comet land in a later
 * phase but the interface is intentionally backend-agnostic so they can
 * be added without changes to the submit pipeline or the UI surfaces
 * that consume runs.
 */

export type TrackerBackend = "mlflow" | "wandb" | "comet";

/**
 * Cluster-level tracker configuration. Stored in
 * cluster.config.experiment_trackers[]. API keys are NOT included here in
 * Phase 1 — MLflow is the only supported backend and tends to be either
 * unauthenticated or use basic-auth embedded in the URL. Phase 2 will
 * introduce per-user API keys in a separate model.
 */
export interface ExperimentTracker {
  id: string;
  name: string;
  backend: TrackerBackend;
  /** Base URL of the tracking server (MLflow). */
  trackingUri: string;
  /** Optional default experiment / project name used when the submitter doesn't override. */
  defaultExperimentName?: string;
  /** Disable without deleting — Phase 1 omits this from the UI but the field exists. */
  enabled?: boolean;
  createdAt?: string;
}

/**
 * Context the submit pipeline hands the adapter when creating a new run.
 * Tags here become MLflow tags / W&B config / Comet other(metadata).
 */
export interface RunContext {
  /** Aura job id (uuid). */
  jobId: string;
  /** Aura cluster id. */
  clusterId: string;
  /** Display name on the cluster (for tags). */
  clusterName?: string;
  /** Email of the Aura user submitting the job. */
  userEmail?: string;
  /** Username on the cluster's controller / login node. */
  unixUsername?: string;
  /** Run display name — optional, falls back to the Slurm job name. */
  runName?: string;
  /** Experiment / project to attach the run to. Falls back to the tracker's default. */
  experimentName?: string;
}

/**
 * Result of pre-creating a run. The submit pipeline persists these to
 * the Job row so the UI can render a deep-link, and the adapter can later
 * look up the run for metrics/artifacts without a search.
 */
export interface CreatedRun {
  runId: string;
  runUrl: string;
  /**
   * Free-form payload the adapter wants to remember about the run —
   * MLflow needs the experiment id to build deep-links, W&B will want
   * the entity/project, etc. Phase 1 stuffs this into the audit metadata
   * only; later phases may persist it.
   */
  extra?: Record<string, unknown>;
}

export interface TestConnectionResult {
  ok: boolean;
  /** Short human-readable detail for the UI. */
  detail: string;
}

export interface TrackerAdapter {
  backend: TrackerBackend;
  /** Cheap reachability + permissions probe. */
  testConnection(tracker: ExperimentTracker): Promise<TestConnectionResult>;
  /** Create a run on the tracker side and return its id + deep link. */
  createRun(tracker: ExperimentTracker, ctx: RunContext): Promise<CreatedRun>;
  /**
   * Bash snippet inserted INSIDE the per-user sudo shell, before the
   * user's job script runs. Must export the env vars the user's code
   * needs to log into the same run (MLFLOW_RUN_ID for MLflow, etc.).
   * Never include secrets that shouldn't appear in job stdout.
   */
  preStartShell(tracker: ExperimentTracker, run: CreatedRun, ctx: RunContext): string;
  /** Static deep-link from a saved (trackerId, runId) pair. */
  deepLink(tracker: ExperimentTracker, runId: string, extra?: Record<string, unknown>): string;
}
