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
import { sshExecScript } from "./ssh-exec";
import { startJobWatcher } from "./job-watcher";

export interface SubmitJobInput {
  clusterId: string;
  userId: string;
  script: string;
  partition: string;
  /** Optional gitops provenance — persisted on the Job row. */
  sourceRef?: string;
  sourceName?: string;
  /** Audit metadata extension (e.g. { via: "gitops" }). */
  auditExtra?: Record<string, unknown>;
}

export async function submitJob(input: SubmitJobInput): Promise<Job> {
  const { clusterId, userId, script, partition, sourceRef, sourceName, auditExtra } = input;

  const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } });
  if (!cluster) throw new Error("Cluster not found");
  if (cluster.status !== "ACTIVE" && cluster.status !== "DEGRADED") {
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

  const job = await prisma.job.create({
    data: {
      clusterId,
      userId,
      script,
      partition,
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
          onStream: (line) => stdoutLines.push(line),
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
