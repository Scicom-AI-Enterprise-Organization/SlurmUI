// Node-runtime-only side of the instrumentation hook. Split out so the
// Edge-runtime bundle webpack builds for instrumentation.ts never traces
// into Node built-ins (child_process, fs, etc).

import { startGitopsJobsMonitor } from "./lib/gitops-jobs";
import { prisma } from "./lib/prisma";
import { startJobWatcher, isWatcherRunning } from "./lib/job-watcher";

startGitopsJobsMonitor();

// Re-attach watchers to any job left in flight by a prior server process.
// Without this, every redeploy / dev-server restart silently orphans every
// RUNNING/PENDING job — the slurm job continues but Aura's DB stops getting
// updates because the long-lived SSH tail child was killed with the prior
// process. Symptoms: UI shows status=RUNNING, output column frozen.
//
// Best-effort: errors here must NEVER block startup. A bad cluster row or
// missing SSH key just means that one job stays orphaned; everyone else
// recovers.
async function reattachWatchersOnBoot() {
  try {
    const jobs = await prisma.job.findMany({
      where: { status: { in: ["PENDING", "RUNNING"] } },
      include: { cluster: { include: { sshKey: true } } },
    });
    let attached = 0;
    for (const j of jobs) {
      if (!j.slurmJobId) continue;
      if (!j.cluster || !j.cluster.sshKey) continue;
      if (isWatcherRunning(j.id)) continue;
      const ok = startJobWatcher(j.cluster as any, j as any);
      if (ok) attached++;
    }
    if (attached > 0) {
      console.log(`[boot] re-attached job watchers: ${attached}/${jobs.length}`);
    }
  } catch (e) {
    console.error(`[boot] watcher re-attach failed (non-fatal):`, e instanceof Error ? e.message : e);
  }
}

// Fire-and-forget — don't block instrumentation register() on a DB call.
reattachWatchersOnBoot();
