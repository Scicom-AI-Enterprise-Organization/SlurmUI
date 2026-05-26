/**
 * Internal job-submission helper.
 *
 * Single entry point used by both the REST handler (POST /api/clusters/[id]/jobs)
 * and the GitOps reconciler (lib/gitops-jobs.ts). Holds the SSH/NATS branching
 * so callers don't duplicate it.
 *
 * Caller is responsible for authorization (the route enforces ClusterUser
 * ACTIVE; the reconciler trusts the manifest after it has resolved the user).
 */

import type { Job } from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { sendCommandAndWait, publishCommand } from "./nats";
import { effectiveClusterStatus } from "./cluster-health";
import { sshExecScript, sshExecSimple } from "./ssh-exec";
import { startJobWatcher } from "./job-watcher";
import { extractJobName } from "./job-list-transform";
import { adapterFor, findTrackerInConfig } from "./experiment-trackers";
import type { CreatedRun, ExperimentTracker, RunContext } from "./experiment-trackers/types";

interface ClusterForSlurmQuery {
  id: string;
  controllerHost: string;
  sshUser: string;
  sshPort: number;
  sshBastion: boolean;
  sshJumpHost: string | null;
  sshJumpUser: string | null;
  sshJumpPort: number | null;
  sshProxyCommand: string | null;
  sshJumpProxyCommand: string | null;
  connectionMode: string;
}

/**
 * Ask Slurm directly for the names of currently-RUNNING jobs.
 *
 * Returns null on any infrastructure failure (SSH down, no key, NATS
 * cluster, squeue exits non-zero) so the caller can fall back to the
 * cheaper DB-side check rather than blocking the submit on transient
 * cluster issues.
 *
 * SSH-only — NATS-mode clusters fall through to the DB check below.
 * Could be wired through the agent's `list_jobs` command later if
 * NATS becomes a common path here, but every NATS cluster we have today
 * also has SSH credentials configured for setup work, and adding a
 * roundtrip there would slow non-Slurm submits too.
 */
async function fetchRunningSlurmNames(cluster: ClusterForSlurmQuery): Promise<Set<string> | null> {
  if (cluster.connectionMode !== "SSH") return null;
  const withKey = await prisma.cluster.findUnique({
    where: { id: cluster.id },
    include: { sshKey: true },
  });
  if (!withKey?.sshKey) return null;

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: withKey.sshKey.privateKey,
    bastion: cluster.sshBastion,
    jumpHost: cluster.sshJumpHost ?? undefined,
    jumpUser: cluster.sshJumpUser ?? undefined,
    jumpPort: cluster.sshJumpPort ?? undefined,
    proxyCommand: cluster.sshProxyCommand ?? undefined,
    jumpProxyCommand: cluster.sshJumpProxyCommand ?? undefined,
  };

  // -h: no header, --states=R: only RUNNING (matches our uniqueness rule),
  // -o "%200j": job name padded to 200 cols (Slurm truncates at the column
  // width — too small a width silently chops long names).
  const res = await sshExecSimple(target, `squeue -h --states=R -o "%200j" 2>/dev/null`);
  if (!res.success) return null;

  const names = new Set<string>();
  for (const raw of res.stdout.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // squeue%j is space-padded right; we already trimmed both sides.
    names.add(trimmed);
  }
  return names;
}

/**
 * Resolve the job name we'll persist on the row. Priority:
 *   1. explicit `name` argument on the call (used by the v1 API),
 *   2. the gitops `sourceName` (already validated upstream),
 *   3. the `#SBATCH --job-name=` directive parsed out of the script.
 *
 * Returned name MUST contain no whitespace — Slurm itself accepts
 * spaces but our uniqueness model and most tooling assume one token,
 * and a name with spaces tends to indicate a copy-paste accident.
 *
 * Throws on empty / whitespace-bearing names so the caller (UI/API)
 * can show the message verbatim.
 */
function resolveJobName(opts: { name?: string; sourceName?: string; script: string }): string {
  const raw = (opts.name ?? opts.sourceName ?? extractJobName(opts.script) ?? "").trim();
  if (!raw) {
    throw new Error("Job name is required — set `#SBATCH --job-name=<name>` in the script (or pass `name` in the API body).");
  }
  if (/\s/.test(raw)) {
    throw new Error(`Job name "${raw}" contains whitespace. Names may use any non-whitespace characters (letters, digits, dash, underscore, dot, colon, etc.).`);
  }
  return raw;
}

export interface SubmitJobInput {
  clusterId: string;
  userId: string;
  script: string;
  partition: string;
  /** Explicit job name. When omitted, falls back to sourceName, then to
   * the `#SBATCH --job-name=` directive in the script. */
  name?: string;
  /** Optional gitops provenance — persisted on the Job row. */
  sourceRef?: string;
  sourceName?: string;
  /** Audit metadata extension (e.g. { via: "gitops" }). */
  auditExtra?: Record<string, unknown>;
  /** Optional log sink — every SSH stdout line passes through this callback
   * in addition to the internal buffer. Lets callers (e.g. the resubmit
   * route) tee output into a BackgroundTask so the UI can show a live log. */
  onLogLine?: (line: string) => void;
  /**
   * Optional experiment-tracker linkage. When set, submitJob looks up the
   * tracker on cluster.config.experiment_trackers, pre-creates a run on the
   * backend (MLflow / W&B / Comet), persists the run id + deep link to the
   * Job row, and prepends the adapter's preStartShell snippet to the job
   * script so user code can log into the right run via env vars.
   */
  tracker?: {
    trackerId: string;
    experimentName?: string;
    runName?: string;
  };
  /**
   * Pick a Git credential from cluster.config.code_credentials.github[].
   * When omitted: auto-pick the only configured entry if there's exactly
   * one (mirrors the tracker auto-pick rule). Multiple credentials with
   * no explicit pick → no token injected, private clones fail. The UI's
   * new-job form requires a selection when multiple exist.
   */
  gitCredentialId?: string;
}

/**
 * Insert the adapter's prelude into a shell script AFTER the shebang
 * and any contiguous block of `#SBATCH` / comment lines. sbatch only
 * parses `#SBATCH` directives from the head of the file — it stops at
 * the first non-comment, non-blank, non-`#SBATCH` line. Inserting our
 * `export …` block before the directives makes sbatch ignore every
 * `--mem=…`, `--gres=…`, `--cpus-per-task=…` etc. and fall back to
 * partition defaults, which silently breaks the job spec.
 *
 * Algorithm: walk from line 1 (past the shebang on line 0). As long as
 * the line is blank, a `#` comment, or `#SBATCH`, keep walking. Insert
 * the prelude immediately before the first line that breaks that
 * pattern.
 */
/**
 * Sentinel used in the script's secrets-source line. submit-job replaces
 * this with the actual per-job path (`/tmp/.aura-secrets-<jobId8>.env`)
 * right before base64-encoding the script for the sbatch wrapper. The
 * indirection exists because the script body is built before
 * `prisma.job.create`, so the real job.id isn't available yet.
 */
const SECRETS_PATH_SENTINEL = "__AURA_SECRETS_PATH__";

/**
 * Shell single-quote escape, same trick as ssh-mux/mlflow: wrap in '…' and
 * escape any embedded ' as '\''. Used to build the per-job secrets file.
 */
function shQuote(s: string): string {
  return `'${(s ?? "").replace(/'/g, "'\\''")}'`;
}

/**
 * Strip any prior Aura tracker prelude + secrets-source block from a
 * script before re-injecting a fresh one. Needed on edit-and-resubmit
 * because the script the user edited still contains the OLD prelude
 * (possibly with a redacted '********' password from the GET response)
 * — replaying that verbatim would either stack two preludes or, worse,
 * propagate the literal "********" into the user's process env.
 *
 * Removes:
 *   "# --- aura: experiment tracker (...) prelude ---"
 *   …everything in between…
 *   "# --- end aura prelude ---"
 *
 * And the secrets-source block:
 *   "# Pull cluster-level credentials staged in a 0600 file."
 *   …up to and including `unset __AURA_SECRETS_FILE`…
 *
 * Idempotent: a script with no Aura blocks is returned unchanged.
 */
function stripAuraPrelude(script: string): string {
  if (!script.includes("# --- aura:") && !script.includes("__AURA_SECRETS_FILE")) {
    return script;
  }
  const lines = script.split("\n");
  const out: string[] = [];
  let inPrelude = false;
  let inSecrets = false;
  for (const line of lines) {
    if (!inPrelude && !inSecrets) {
      if (/^# --- aura:/.test(line)) { inPrelude = true; continue; }
      if (/Pull cluster-level credentials staged in a 0600 file/.test(line)) { inSecrets = true; continue; }
      out.push(line);
      continue;
    }
    if (inPrelude) {
      if (/^# --- end aura prelude ---/.test(line)) inPrelude = false;
      continue;
    }
    if (inSecrets) {
      if (/^unset __AURA_SECRETS_FILE/.test(line)) inSecrets = false;
      continue;
    }
  }
  // Drop a trailing blank line left behind when the block was at the top.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + (script.endsWith("\n") ? "\n" : "");
}

function injectPrelude(script: string, prelude: string): string {
  const lines = script.split("\n");
  let insertAt = 0;
  if (lines.length > 0 && lines[0].startsWith("#!")) {
    insertAt = 1;
  }
  while (insertAt < lines.length) {
    const t = lines[insertAt].trim();
    if (t === "" || t.startsWith("#")) {
      insertAt++;
      continue;
    }
    break;
  }
  return [
    ...lines.slice(0, insertAt),
    prelude,
    ...lines.slice(insertAt),
  ].join("\n");
}

export async function submitJob(input: SubmitJobInput): Promise<Job> {
  const { clusterId, userId, partition, name, sourceRef, sourceName, auditExtra } = input;
  let { script } = input;

  // Resolve + validate the job name BEFORE any DB writes — easier to
  // surface as a 400 to the caller than to roll back a half-created row.
  const jobName = resolveJobName({ name, sourceName, script });

  const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } });
  if (!cluster) throw new Error("Cluster not found");
  // Trust the latest health probe over the lazily-updated DB column —
  // see app/api/clusters/[id]/jobs/route.ts for the same reasoning.
  const eff = effectiveClusterStatus(cluster);
  if (eff !== "ACTIVE" && eff !== "DEGRADED") {
    throw new Error("Cluster is not accepting jobs");
  }

  // Per-cluster "GitOps only" switch. When on, the only legitimate caller is
  // the reconciler (which passes a sourceRef from the manifest's sha256).
  // REST / UI submissions come through without a sourceRef — reject those.
  const clusterCfg = (cluster.config ?? {}) as Record<string, unknown>;
  if (clusterCfg.gitops_only_jobs === true && !sourceRef) {
    throw new Error("This cluster only accepts jobs submitted via Git Jobs. Commit a manifest to the configured repo instead.");
  }

  const dbUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!dbUser) throw new Error("User not found");

  // Experiment-tracker pre-create. We do this BEFORE the Job row is inserted
  // so the Job is born with the run id stamped onto it — avoids a second
  // DB write right after the create, and means a transient tracker outage
  // shows up at submit time (visible) instead of after sbatch has already
  // accepted the job (invisible).
  let resolvedTracker: ExperimentTracker | null = null;
  let createdRun: CreatedRun | null = null;
  let runContext: RunContext | null = null;
  if (input.tracker) {
    resolvedTracker = findTrackerInConfig(
      cluster.config as Record<string, unknown> | null,
      input.tracker.trackerId,
    );
    if (!resolvedTracker) {
      throw new Error(`Experiment tracker '${input.tracker.trackerId}' not found on this cluster.`);
    }
    const adapter = adapterFor(resolvedTracker);
    if (!adapter) {
      throw new Error(`No adapter wired for backend '${resolvedTracker.backend}'.`);
    }
    runContext = {
      // Job id isn't known yet — we generate the prelude AFTER creating the
      // Job row below. createRun only needs identification for tags, which
      // we backfill with the cluster + user context (the run id from MLflow
      // is what links them, not the Aura job id).
      jobId: "(pending)",
      clusterId,
      clusterName: cluster.name,
      userEmail: dbUser.email ?? undefined,
      unixUsername: dbUser.unixUsername ?? undefined,
      experimentName: input.tracker.experimentName,
      runName: input.tracker.runName ?? jobName,
    };
    try {
      createdRun = await adapter.createRun(resolvedTracker, runContext);
    } catch (err) {
      throw new Error(
        `Tracker '${resolvedTracker.name}' rejected the new run: ${(err as Error).message}`,
      );
    }
  }

  // Running-job uniqueness check. Slurm itself is the source of truth —
  // squeue --states=R lists every running job on the controller right
  // now, including ones submitted via the CLI outside Aura. We fall back
  // to a DB-only check when the Slurm query can't run (NATS-mode
  // cluster, SSH transient error). Both checks block on RUNNING only:
  // PENDING and terminal states keep the name historically but don't
  // block reuse, so a user can rerun "training" tomorrow without renaming.
  const slurmNames = await fetchRunningSlurmNames(cluster).catch(() => null);
  if (slurmNames !== null) {
    if (slurmNames.has(jobName)) {
      throw new Error(
        `Job name "${jobName}" is already in use by a RUNNING job on this cluster (per squeue). ` +
        `Cancel it, wait for it to finish, or pick a different name.`,
      );
    }
  } else {
    const runningConflict = await prisma.job.findFirst({
      where: { clusterId, name: jobName, status: "RUNNING" },
      select: { id: true, slurmJobId: true },
    });
    if (runningConflict) {
      const slurmHint = runningConflict.slurmJobId ? ` (slurmJobId=${runningConflict.slurmJobId})` : "";
      throw new Error(
        `Job name "${jobName}" is already in use by a RUNNING job on this cluster${slurmHint}. ` +
        `Cancel it, wait for it to finish, or pick a different name.`,
      );
    }
  }

  // Bake the tracker prelude into the persisted script too — the Job
  // detail page renders the exact script we submitted, and users want to
  // see what was injected (helps debugging "why isn't my run showing
  // metrics?"). It also means resubmit picks the prelude up automatically.
  //
  // Secrets the adapter returns are NOT embedded — they're moved to a
  // per-job env file written separately on the controller (see the
  // `secretsToStage` block in the sbatch wrapper below). That keeps
  // tokens out of the script that ends up in slurmdbd's job table.
  let secretsToStage: Record<string, string> = {};
  // Strip any previous Aura prelude before re-injecting. Idempotent — a
  // fresh user script with no prior prelude is untouched. Critical for
  // edit-and-resubmit: the script the UI sends back contains a redacted
  // ('********') copy of the original prelude, which we MUST NOT
  // propagate verbatim.
  script = stripAuraPrelude(script);
  // Build a list of prelude fragments from every configured integration.
  // Today: experiment tracker (mlflow/wandb) + GitHub code credentials.
  // Each fragment is `{ script, secrets }`; we merge all of them into a
  // single injected block + a single secrets file.
  const preludeFragments: string[] = [];
  if (resolvedTracker && createdRun && runContext) {
    const adapter = adapterFor(resolvedTracker)!;
    const raw = adapter.preStartShell(resolvedTracker, createdRun, runContext);
    const norm = typeof raw === "string" ? { script: raw, secrets: {} } : raw;
    preludeFragments.push(norm.script);
    if (norm.secrets) Object.assign(secretsToStage, norm.secrets);
  }
  // Git credentials live in cluster.config.code_credentials.github[]. The
  // caller can pick one via input.gitCredentialId; otherwise we default
  // to the only configured credential when there's exactly one (matches
  // the tracker auto-pick rule on this cluster). Tokens are secret-staged
  // (same per-job 0600 file pattern as MLflow/W&B passwords).
  const codeCreds = ((cluster.config ?? {}) as Record<string, unknown>).code_credentials as
    | { github?: unknown }
    | undefined;
  type GhEntry = { id?: string; name?: string; username?: string; token?: string };
  const ghList: GhEntry[] = Array.isArray(codeCreds?.github)
    ? (codeCreds!.github as GhEntry[])
    : (codeCreds?.github && typeof codeCreds.github === "object"
        // Legacy single-object shape — wrap so the same code below works.
        ? [codeCreds.github as GhEntry]
        : []);
  // Three input states for gitCredentialId:
  //   undefined  → auto-pick (server picks the single configured cred when
  //                exactly one exists; CLI/API caller convenience)
  //   "none"     → explicit opt-out, no token injected even if 1+ creds exist
  //   <id>       → use that specific cred; throw if it doesn't exist
  // The UI's new-job form defaults to "none" so the user has to opt IN.
  let chosenGh: GhEntry | null = null;
  if (input.gitCredentialId === "none") {
    chosenGh = null;
  } else if (input.gitCredentialId) {
    chosenGh = ghList.find((e) => e.id === input.gitCredentialId) ?? null;
    if (!chosenGh) {
      throw new Error(`Git credential '${input.gitCredentialId}' not found on this cluster.`);
    }
  } else if (ghList.length === 1) {
    chosenGh = ghList[0];
  }
  // ghList.length > 1 with no input.gitCredentialId → leave chosenGh
  // null. The job runs without a token; private clones will fail under
  // BatchMode. The new-job form forces a selection when multiple exist.
  const ghToken = chosenGh?.token?.trim();
  if (ghToken) {
    const ghUser = chosenGh!.username?.trim() || "x-access-token";
    // Process-scoped git config via GIT_CONFIG_COUNT/_KEY/_VALUE env vars
    // (git ≥ 2.31). Reasons we DON'T use `git config --global`:
    //   1. `--global` writes to ~/.gitconfig — pollutes future jobs on the
    //      same node. Multiple "url".insteadOf entries with the SAME url
    //      key overwrite each other; even `--add` leaves residue across
    //      job boundaries.
    //   2. A failed job that ran the config command with an unset token
    //      (e.g. an earlier ordering bug) leaves a permanent ~/.gitconfig
    //      entry with empty creds that breaks later runs.
    //   3. The env-var form is naturally scoped to the slurm job's
    //      process tree — when the job ends, the config is gone with it.
    //
    // Two entries: one rewrites HTTPS clone URLs, one rewrites the SSH
    // shorthand (`git@github.com:org/repo.git`). Both rewrite TO the
    // same authenticated HTTPS URL — git ends up using HTTPS+token even
    // when the user typed an SSH URL.
    preludeFragments.push([
      "# --- aura: Git credentials ---",
      // Token sourced from the secrets file ABOVE this fragment — literal
      // value never appears in this script.
      `export GIT_CONFIG_COUNT=2`,
      `export GIT_CONFIG_KEY_0="url.https://${ghUser}:\${GITHUB_TOKEN}@github.com/.insteadOf"`,
      `export GIT_CONFIG_VALUE_0="https://github.com/"`,
      `export GIT_CONFIG_KEY_1="url.https://${ghUser}:\${GITHUB_TOKEN}@github.com/.insteadOf"`,
      `export GIT_CONFIG_VALUE_1="git@github.com:"`,
      "# --- end aura prelude ---",
      "",
    ].join("\n"));
    secretsToStage.GITHUB_TOKEN = ghToken;
  }
  if (preludeFragments.length > 0) {
    // ORDER MATTERS: the secrets-source block has to run BEFORE the
    // per-integration fragments. Otherwise commands like the Git config
    // rewrite (`url.…:${GITHUB_TOKEN}@github.com/`) expand $GITHUB_TOKEN
    // to empty at the moment they execute, since the token is only
    // sourced AFTER. Putting the source block first means every
    // fragment downstream sees the env vars it expects.
    const secretsSourceBlock = Object.keys(secretsToStage).length > 0
      ? [
          `# Pull cluster-level credentials staged in a 0600 file. Not embedded`,
          `# in this script body so the secret never lands in slurmdbd's job`,
          `# table or in any audit dump. ${SECRETS_PATH_SENTINEL} gets replaced`,
          `# with the per-job file path right before the script is base64'd in`,
          `# the sbatch wrapper.`,
          `__AURA_SECRETS_FILE=${SECRETS_PATH_SENTINEL}`,
          `if [ -r "$__AURA_SECRETS_FILE" ]; then`,
          `  set -a; . "$__AURA_SECRETS_FILE"; set +a`,
          `  rm -f "$__AURA_SECRETS_FILE"`,
          `fi`,
          `unset __AURA_SECRETS_FILE`,
          ``,
        ].join("\n")
      : "";
    const prelude = secretsSourceBlock + preludeFragments.join("\n");
    script = injectPrelude(script, prelude);
  }

  const job = await prisma.job.create({
    data: {
      clusterId,
      userId,
      script,
      partition,
      name: jobName,
      status: "PENDING",
      sourceRef: sourceRef ?? null,
      sourceName: sourceName ?? null,
      experimentTrackerId: resolvedTracker?.id ?? null,
      experimentRunId: createdRun?.runId ?? null,
      experimentRunUrl: createdRun?.runUrl ?? null,
    },
  });

  try {
    const config = cluster.config as Record<string, unknown>;
    const username = dbUser.unixUsername ?? "";
    const dataNfsPath = (config.data_nfs_path as string | undefined) ?? "";
    const workDir = username && dataNfsPath ? `${dataNfsPath}/${username}` : "";

    if (cluster.connectionMode === "SSH") {
      const clusterWithKey = await prisma.cluster.findUnique({
        where: { id: clusterId },
        include: { sshKey: true },
      });
      if (!clusterWithKey?.sshKey) throw new Error("Cluster has no SSH key assigned");

      const target = {
        host: cluster.controllerHost,
        user: cluster.sshUser,
        port: cluster.sshPort,
        privateKey: clusterWithKey.sshKey.privateKey,
        bastion: cluster.sshBastion,
      };

      if (!username) {
        throw new Error("Cannot submit — your user has not been provisioned with a Linux account.");
      }
      const submitDir = workDir || "/tmp";
      const scriptName = `.aura-job-${job.id.slice(0, 8)}.sh`;
      const scriptPath = `${submitDir}/${scriptName}`;
      // Per-job secrets file. The script body has a sentinel that we
      // substitute with this path before base64-encoding, and the wrapper
      // below stages the actual contents on the controller before sbatch
      // runs. Empty when no tracker secrets to pass through.
      const secretsName = `.aura-secrets-${job.id.slice(0, 8)}.env`;
      const secretsPath = `${submitDir}/${secretsName}`;
      // split+join, not .replace(), because the sentinel appears in both the
      // comment ("${SECRETS_PATH_SENTINEL} gets replaced …") and the actual
      // `__AURA_SECRETS_FILE=…` assignment. .replace would only touch the
      // first occurrence and the assignment line would still hold the
      // literal sentinel — making the source line a no-op and the secret
      // never reach the job's env.
      const finalScript = script.split(SECRETS_PATH_SENTINEL).join(secretsPath);
      const scriptB64 = Buffer.from(finalScript).toString("base64");
      const secretsBody = Object.entries(secretsToStage)
        .map(([k, v]) => `export ${k}=${shQuote(v)}`)
        .join("\n");
      const secretsB64 = secretsBody ? Buffer.from(secretsBody).toString("base64") : "";

      // `-n` on sudo throws "a password is required" instantly instead of
      // hanging on a TTY prompt. Without it, an unresolvable target user
      // (provisioning drift) makes the whole submit block until the 60s SSH
      // timeout — UI spinner just sits there.
      const wrapper = `#!/bin/bash
set +e
# Emit a known trace line on exit so the bastion-mode ssh layer can detect
# "script finished" and tear down the session immediately instead of
# waiting on its idle-timeout fallback.
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT
S=""; [ "$(id -u)" != "0" ] && S="sudo -n"

# Fail fast if the target Linux user doesn't exist — otherwise the sudo
# call below spends seconds on audit-plugin init before erroring.
if ! id ${username} >/dev/null 2>&1; then
  echo "__AURA_SBATCH_OUT__=Linux user '${username}' does not exist on the controller. Re-provision the user from the admin Users tab."
  echo "__AURA_SBATCH_EXIT__=127"
  exit 127
fi

$S mkdir -p ${submitDir}
$S chown ${username}:${username} ${submitDir} 2>/dev/null || true

echo "${scriptB64}" | base64 -d | $S tee ${scriptPath} > /dev/null
$S chown ${username}:${username} ${scriptPath}
# 0600 (not 0755) so other unix users on the controller cannot cat the
# script. The owning user + root + slurmd (running as the user via
# sbatch's setuid) can still read+execute it.
$S chmod 600 ${scriptPath}
${secretsB64 ? `
# Stage per-job secrets file BEFORE sbatch reads the script. The script's
# prelude sources + deletes this file at job-runtime — so secrets land in
# the env of the user's Python/etc but never appear in (a) the script
# body submitted to sbatch, (b) slurmdbd's stored copy of the script, or
# (c) any audit dump of /tmp/.aura-job-*.sh.
echo "${secretsB64}" | base64 -d | $S tee ${secretsPath} > /dev/null
$S chown ${username}:${username} ${secretsPath}
$S chmod 600 ${secretsPath}
` : ""}
OUT=$(sudo -n -u ${username} -H bash -c "cd ${submitDir} && sbatch --parsable ${scriptPath}" 2>&1)
RC=$?
echo "__AURA_SBATCH_EXIT__=$RC"
echo "__AURA_SBATCH_OUT__=$OUT"
exit $RC
`;

      const stdoutLines: string[] = [];
      const success = await new Promise<boolean>((resolve) => {
        sshExecScript(target, wrapper, {
          onStream: (line) => {
            stdoutLines.push(line);
            input.onLogLine?.(line);
          },
          onComplete: (ok) => resolve(ok),
        });
      });

      const full = stdoutLines.join("\n");
      const outMatch = full.match(/__AURA_SBATCH_OUT__=([\s\S]*?)(?:\n__|$)/);
      const sbatchOut = outMatch ? outMatch[1].trim() : full;

      if (!success) throw new Error(sbatchOut || "sbatch failed");

      const idMatch = sbatchOut.match(/(\d+)/);
      if (!idMatch) throw new Error(sbatchOut || "Could not parse Slurm job ID");
      const slurmJobId = parseInt(idMatch[1], 10);

      const updated = await prisma.job.update({
        where: { id: job.id },
        data: { slurmJobId, status: "RUNNING" },
      });

      startJobWatcher(clusterWithKey as any, updated as any);

      await logAudit({
        action: "job.submit",
        entity: "Job",
        entityId: job.id,
        metadata: {
          clusterId,
          clusterName: cluster.name,
          partition,
          slurmJobId,
          mode: "ssh",
          submittedBy: dbUser.email,
          experimentTracker: resolvedTracker
            ? { id: resolvedTracker.id, backend: resolvedTracker.backend, runId: createdRun?.runId }
            : undefined,
          ...auditExtra,
        },
      });

      return updated;
    }

    // NATS mode
    const result = await sendCommandAndWait(
      clusterId,
      {
        request_id: job.id,
        type: "submit_job",
        payload: {
          script,
          partition,
          job_name: `aura-${job.id.slice(0, 8)}`,
          work_dir: workDir,
          username,
        },
      },
      60_000
    ) as { slurm_job_id?: number; output_file?: string };

    const updated = await prisma.job.update({
      where: { id: job.id },
      data: { slurmJobId: result.slurm_job_id ?? null, status: "RUNNING" },
    });

    if (result.slurm_job_id && result.output_file) {
      publishCommand(clusterId, {
        request_id: job.id,
        type: "watch_job",
        payload: {
          slurm_job_id: result.slurm_job_id,
          output_file: result.output_file,
        },
      }).catch((err) => console.error("[submit-job] watch_job dispatch:", err));
    } else if (result.slurm_job_id) {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "COMPLETED", exitCode: 0 },
      }).catch(() => {});
    }

    await logAudit({
      action: "job.submit",
      entity: "Job",
      entityId: job.id,
      metadata: {
        clusterId,
        clusterName: cluster.name,
        partition,
        slurmJobId: result.slurm_job_id,
        submittedBy: dbUser.email,
        experimentTracker: resolvedTracker
          ? { id: resolvedTracker.id, backend: resolvedTracker.backend, runId: createdRun?.runId }
          : undefined,
        ...auditExtra,
      },
    });

    return updated;
  } catch (err) {
    // Persist the submission error onto the Job row so the detail page has
    // something to render. Without this, slurmJobId=null + output=null leaves
    // the user with a FAILED row and no idea why.
    const errMsg = err instanceof Error ? err.message : String(err);
    const stamp = new Date().toISOString();
    const outputBody = `[aura] job submission failed @ ${stamp}\n${errMsg}\n`;
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "FAILED", output: outputBody },
    }).catch(() => {});

    await logAudit({
      action: "job.submit_failed",
      entity: "Job",
      entityId: job.id,
      metadata: {
        clusterId,
        clusterName: cluster.name,
        partition,
        error: errMsg,
        submittedBy: dbUser.email,
        ...auditExtra,
      },
    });
    throw err;
  }
}
