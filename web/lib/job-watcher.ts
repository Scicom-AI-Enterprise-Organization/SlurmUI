/**
 * Background watcher for SSH-mode Slurm jobs.
 *
 * Runs detached from any HTTP request: started when a job is submitted (or
 * when the stream endpoint is first hit for a job that has no watcher), and
 * survives page refresh / tab close. Periodically flushes captured stdout to
 * Job.output and marks the final status when the job leaves the queue.
 *
 * Stream endpoint polls Job.output + Job.status to render live updates.
 */

import { prisma } from "./prisma";
import { sshExecScript } from "./ssh-exec";
import { dispatch as dispatchAlert } from "./alerts";

interface Cluster {
  id: string;
  controllerHost: string;
  sshUser: string;
  sshPort: number;
  sshBastion: boolean;
  sshKey: { privateKey: string } | null;
}

interface Job {
  id: string;
  slurmJobId: number | null;
  script: string;
}

// jobId -> true. Prevents duplicate watchers when two requests race.
const running = new Map<string, boolean>();

function parseOutputHint(script: string, slurmJobId: number): string | null {
  const m = script.match(/#SBATCH\s+(?:--output|-o)[=\s]+(\S+)/);
  return m ? m[1].replace(/%j/g, String(slurmJobId)) : null;
}

export function startJobWatcher(cluster: Cluster, job: Job): boolean {
  if (!cluster.sshKey || !job.slurmJobId) return false;
  if (running.get(job.id)) return false;
  running.set(job.id, true);

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const outputHint = parseOutputHint(job.script, job.slurmJobId);

  const remoteScript = `#!/bin/bash
set +e

JOBID=${job.slurmJobId}
HINT="${outputHint ?? ""}"

OUTFILE=""
for i in $(seq 1 10); do
  OUTFILE=$(scontrol show job $JOBID 2>/dev/null | grep -oP 'StdOut=\\K[^ ]+' | head -1)
  if [ -n "$OUTFILE" ] && [ "$OUTFILE" != "(null)" ]; then break; fi
  sleep 1
done

if [ -z "$OUTFILE" ] || [ "$OUTFILE" = "(null)" ]; then
  OUTFILE="$HINT"
fi

if [ -z "$OUTFILE" ]; then
  WORKDIR=$(sacct -j $JOBID -n -o WorkDir%-500 2>/dev/null | head -1 | xargs)
  if [ -z "$WORKDIR" ]; then
    WORKDIR=$(scontrol show job $JOBID 2>/dev/null | grep -oP 'WorkDir=\\K[^ ]+' | head -1)
  fi
  if [ -n "$WORKDIR" ]; then OUTFILE="$WORKDIR/slurm-$JOBID.out"; fi
fi

echo "__AURA_TAIL_START__"

if [ -z "$OUTFILE" ]; then
  echo "[aura] Could not resolve output file for job $JOBID"
  echo "__AURA_TAIL_END__"
  echo "__AURA_JOB_FINAL__="
  exit 0
fi

echo "[aura] Output file: $OUTFILE"

INIT_STATE=$(squeue -j $JOBID -h -o '%T %R' 2>/dev/null)
if [ -n "$INIT_STATE" ]; then
  echo "[aura] Job state: $INIT_STATE"
fi

(
  LAST=""
  GONE=0
  while true; do
    STATE=$(squeue -j $JOBID -h -o '%T %R' 2>/dev/null)
    if [ -z "$STATE" ]; then
      TERM=$(sacct -j $JOBID -n -o State%-20 2>/dev/null | head -1 | awk '{print $1}')
      case "$TERM" in
        COMPLETED|FAILED|CANCELLED*|TIMEOUT|NODE_FAIL|BOOT_FAIL|OUT_OF_MEMORY|DEADLINE|PREEMPTED)
          echo "[aura] Job state: $TERM"
          sleep 2
          pkill -P $$ tail 2>/dev/null
          break
          ;;
        "")
          GONE=$((GONE + 1))
          if [ $GONE -ge 2 ]; then
            echo "[aura] Job left the queue (no accounting — assumed complete)"
            echo "__AURA_ASSUMED_COMPLETE__=1"
            sleep 2
            pkill -P $$ tail 2>/dev/null
            break
          fi
          ;;
      esac
    else
      GONE=0
      if [ "$STATE" != "$LAST" ]; then
        echo "[aura] Job state: $STATE"
        LAST="$STATE"
      fi
    fi
    sleep 3
  done
) &
WATCHER=$!

tail -n +1 -F "$OUTFILE" 2>/dev/null

wait $WATCHER 2>/dev/null

echo "__AURA_TAIL_END__"

FINAL=$(sacct -j $JOBID -n -o State,ExitCode -P 2>/dev/null | head -1)
echo "__AURA_JOB_FINAL__=$FINAL"
`;

  let inTail = false;
  let finalState = "";
  let exitCode = 0;
  let assumedComplete = false;
  const captured: string[] = [];
  let dirty = false;

  // Flush captured output to DB every 2s — cheap enough to keep live-ish.
  const flushInterval = setInterval(async () => {
    if (!dirty) return;
    dirty = false;
    await prisma.job.update({
      where: { id: job.id },
      data: { output: captured.join("\n") },
    }).catch(() => {});
  }, 2000);

  sshExecScript(target, remoteScript, {
    onStream: (line) => {
      if (line.includes("__AURA_TAIL_START__")) { inTail = true; return; }
      if (line.includes("__AURA_TAIL_END__")) { inTail = false; return; }
      if (line.startsWith("__AURA_JOB_FINAL__=")) {
        finalState = line.slice("__AURA_JOB_FINAL__=".length);
        const m = finalState.match(/\|(\d+):(\d+)/);
        if (m) exitCode = parseInt(m[1], 10) || 0;
        return;
      }
      if (line.startsWith("__AURA_ASSUMED_COMPLETE__=")) {
        assumedComplete = true;
        return;
      }
      if (!inTail) return;
      if (line.startsWith("[stderr]")) return;
      captured.push(line);
      dirty = true;
    },
    onComplete: async () => {
      clearInterval(flushInterval);
      running.delete(job.id);

      const state = (finalState.split("|")[0] ?? "").trim().toUpperCase();
      let status: "COMPLETED" | "FAILED" | "CANCELLED" | null = null;
      if (state === "COMPLETED") status = "COMPLETED";
      else if (state.startsWith("CANCELLED")) status = "CANCELLED";
      else if (state && state !== "RUNNING" && state !== "PENDING") status = "FAILED";
      else if (assumedComplete) status = "COMPLETED";

      const data: Record<string, unknown> = {};
      if (status) {
        data.status = status;
        data.exitCode = exitCode;
      }
      if (captured.length > 0) data.output = captured.join("\n");
      if (Object.keys(data).length > 0) {
        await prisma.job.update({ where: { id: job.id }, data }).catch(() => {});
      }

      // Fire an alert channel message on terminal states so operators can be
      // paged in Slack/Teams. Action names match the audit-log convention.
      if (status) {
        const action =
          status === "COMPLETED" ? "job.completed" :
          status === "CANCELLED" ? "job.cancelled" : "job.failed";
        dispatchAlert(action, {
          jobId: job.id,
          slurmJobId: job.slurmJobId,
          exitCode,
          state: state || status,
        }).catch(() => {});
      }
    },
  });

  return true;
}

export function isWatcherRunning(jobId: string): boolean {
  return running.get(jobId) === true;
}
