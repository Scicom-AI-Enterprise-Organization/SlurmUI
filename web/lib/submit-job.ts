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
}

export async function submitJob(input: SubmitJobInput): Promise<Job> {
  const { clusterId, userId, script, partition, name, sourceRef, sourceName, auditExtra } = input;

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
      const scriptB64 = Buffer.from(script).toString("base64");

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
$S chmod 755 ${scriptPath}

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
