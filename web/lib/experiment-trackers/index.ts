/**
 * Adapter registry — pick the right adapter for a tracker entry by its
 * backend tag. Adding W&B/Comet later is a one-line change here plus a
 * new file in this folder.
 */
import { mlflowAdapter } from "./mlflow";
import { wandbAdapter } from "./wandb";
import type { ExperimentTracker, TrackerAdapter } from "./types";

const ADAPTERS: Record<string, TrackerAdapter> = {
  mlflow: mlflowAdapter,
  wandb: wandbAdapter,
  // comet: cometAdapter,    // future
};

export function adapterFor(tracker: ExperimentTracker): TrackerAdapter | null {
  return ADAPTERS[tracker.backend] ?? null;
}

export function listTrackersFromConfig(
  config: Record<string, unknown> | null | undefined,
): ExperimentTracker[] {
  if (!config) return [];
  const raw = config.experiment_trackers;
  if (!Array.isArray(raw)) return [];
  // Defensively filter — old/migrated rows or malformed JSON shouldn't break
  // callers, just get silently dropped.
  return raw.filter(
    (t): t is ExperimentTracker =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as ExperimentTracker).id === "string" &&
      typeof (t as ExperimentTracker).backend === "string" &&
      typeof (t as ExperimentTracker).trackingUri === "string",
  );
}

export function findTrackerInConfig(
  config: Record<string, unknown> | null | undefined,
  trackerId: string,
): ExperimentTracker | null {
  return listTrackersFromConfig(config).find((t) => t.id === trackerId) ?? null;
}

export type { ExperimentTracker, TrackerAdapter, RunContext, CreatedRun } from "./types";
