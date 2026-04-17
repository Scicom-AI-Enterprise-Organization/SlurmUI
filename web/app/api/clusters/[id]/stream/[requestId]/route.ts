import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readCommandStream } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";
import { startJobWatcher, isWatcherRunning } from "@/lib/job-watcher";

interface RouteParams {
  params: Promise<{ id: string; requestId: string }>;
}

// GET /api/clusters/[id]/stream/[requestId] — SSE bridge from NATS to browser
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id, requestId } = await params;
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  const enc = new TextEncoder();

  // SSH-mode job output streaming: tail the Slurm output file directly.
  // The requestId here is the Aura job ID.
  if (cluster.connectionMode === "SSH" && cluster.sshKey) {
    const job = await prisma.job.findUnique({ where: { id: requestId } }).catch(() => null);
    if (job && job.slurmJobId) {
      // Kick off the detached background watcher if it isn't already running.
      // Covers jobs submitted before watchers existed and after a server restart.
      if (!isWatcherRunning(job.id)) {
        const terminal = job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED";
        if (!terminal) startJobWatcher(cluster as any, job as any);
      }

      return new Response(
        buildDbPollStream(job.id),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            Connection: "keep-alive",
          },
        },
      );
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // client disconnected
        }
      };

      // Timeout — close after 10 minutes if no reply
      const timer = setTimeout(() => {
        send({ type: "complete", success: false, message: "Command timed out after 10 minutes" });
        try { controller.close(); } catch {}
      }, 600_000);

      try {
        for await (const event of readCommandStream(requestId)) {
          if (event.type === "stream") {
            const data = event.data as any;
            send({ type: "stream", line: data.line, seq: data.seq });
          } else {
            // reply — final event
            clearTimeout(timer);
            const data = event.data as any;

            // Synthetic error when stream buffer never existed — buffer expired or
            // watch_job was never dispatched. Don't clobber DB status in this case.
            const isSynthetic = data.payload?.error === "Stream not found — request may have expired";
            if (isSynthetic) {
              send({ type: "complete", success: false, payload: data.payload });
              try { controller.close(); } catch {}
              return;
            }

            const success = data.type === "result";
            const exitCode: number = success ? (data.payload?.exit_code ?? 0) : -1;

            // Update job status in DB if this request maps to a job.
            await prisma.job.update({
              where: { id: requestId },
              data: {
                status: success && exitCode === 0 ? "COMPLETED" : "FAILED",
                exitCode,
                output: data.payload?.output ?? null,
              },
            }).catch(() => {
              // requestId may not be a job ID (e.g. setup commands) — ignore
            });

            send({ type: "complete", success, payload: data.payload });
            try { controller.close(); } catch {}
            return;
          }
        }
      } catch {
        clearTimeout(timer);
        try { controller.close(); } catch {}
      }

      clearTimeout(timer);
    },

    cancel() {
      // Client disconnected
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}

// Stream a job's output by polling the DB. The actual tailing is done by a
// detached background watcher (see lib/job-watcher.ts) so closing the tab
// doesn't stop output capture. Sends only *new* lines since the last poll.
function buildDbPollStream(jobId: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const send = (obj: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {}
      };

      let sent = 0; // count of lines already sent
      let seq = 0;
      const start = Date.now();

      while (true) {
        const j = await prisma.job.findUnique({
          where: { id: jobId },
          select: { status: true, output: true, exitCode: true },
        }).catch(() => null);

        if (!j) {
          send({ type: "complete", success: false, payload: { error: "Job missing" } });
          try { controller.close(); } catch {}
          return;
        }

        const lines = j.output ? j.output.split("\n") : [];
        for (let i = sent; i < lines.length; i++) {
          send({ type: "stream", line: lines[i], seq: seq++ });
        }
        sent = lines.length;

        const terminal =
          j.status === "COMPLETED" || j.status === "FAILED" || j.status === "CANCELLED";
        if (terminal) {
          send({
            type: "complete",
            success: j.status === "COMPLETED",
            payload: { state: j.status, exitCode: j.exitCode },
          });
          try { controller.close(); } catch {}
          return;
        }

        // Bail after 1h of inactivity to avoid zombie connections.
        if (Date.now() - start > 60 * 60_000) {
          try { controller.close(); } catch {}
          return;
        }

        await new Promise((r) => setTimeout(r, 1500));
      }
    },
  });
}

// Stream a running Slurm job's stdout/stderr back to the browser by tailing the
// output file on the controller via SSH. Watches the job state in parallel —
// when it leaves RUNNING/PENDING, fetches the final exit code and closes.
// (Legacy — kept in case we need it for NATS fallback, but currently unused.)
function buildSshJobStream(
  cluster: any,
  slurmJobId: number,
  jobId: string,
  outputHint: string | null,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  // Loop: resolve StdOut via scontrol, tail -F it until the job leaves the queue
  // (sacct reports a terminal state), then emit the exit code. `tail -F` keeps
  // retrying when the file doesn't exist yet (PENDING jobs), and a background
  // watcher kills tail once the job finishes so we don't hang on open file.
  const remoteScript = `#!/bin/bash
set +e

JOBID=${slurmJobId}
HINT="${outputHint ?? ""}"

# Poll for StdOut up to 10s — scontrol forgets fast jobs almost immediately.
OUTFILE=""
for i in $(seq 1 10); do
  OUTFILE=$(scontrol show job $JOBID 2>/dev/null | grep -oP 'StdOut=\\K[^ ]+' | head -1)
  if [ -n "$OUTFILE" ] && [ "$OUTFILE" != "(null)" ]; then break; fi
  sleep 1
done

# Fallback to the path parsed from the job script (--output= with %j expanded).
if [ -z "$OUTFILE" ] || [ "$OUTFILE" = "(null)" ]; then
  OUTFILE="$HINT"
fi

# Last resort: Slurm's default is <WorkDir>/slurm-<jobid>.out. Pull WorkDir from
# sacct (if accounting is on) or from scontrol output we already tried.
if [ -z "$OUTFILE" ]; then
  WORKDIR=$(sacct -j $JOBID -n -o WorkDir%-500 2>/dev/null | head -1 | xargs)
  if [ -z "$WORKDIR" ]; then
    WORKDIR=$(scontrol show job $JOBID 2>/dev/null | grep -oP 'WorkDir=\\K[^ ]+' | head -1)
  fi
  if [ -n "$WORKDIR" ]; then
    OUTFILE="$WORKDIR/slurm-$JOBID.out"
  fi
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

# Background watcher: emit state changes, kill tail once the job finishes.
# Exits when squeue loses the job AND sacct/scontrol has nothing either — this
# covers clusters without slurmdbd where sacct would always be empty.
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
          # Neither squeue nor sacct knows about the job — assume it finished.
          # Wait two polls to avoid racing sbatch registration, then exit.
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

# tail -F retries when the file doesn't yet exist (PENDING jobs).
tail -n +1 -F "$OUTFILE" 2>/dev/null

wait $WATCHER 2>/dev/null

echo "__AURA_TAIL_END__"

FINAL=$(sacct -j $JOBID -n -o State,ExitCode -P 2>/dev/null | head -1)
echo "__AURA_JOB_FINAL__=$FINAL"
`;

  return new ReadableStream({
    start(controller) {
      const send = (obj: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {}
      };

      let seq = 0;
      let finalState = "";
      let exitCode = 0;
      let assumedComplete = false;
      // Bastion sessions emit a shell banner + prompt + command echo before our
      // script runs. Only forward lines between __AURA_TAIL_START__ and
      // __AURA_TAIL_END__ to the browser.
      let inTail = false;
      const captured: string[] = [];

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
          send({ type: "stream", line, seq: seq++ });
        },
        onComplete: async () => {
          // Source of truth: sacct State. The ssh session's own exit code is
          // unreliable here — we pkill `tail` which may surface as non-zero.
          const state = (finalState.split("|")[0] ?? "").trim().toUpperCase();
          let status: "COMPLETED" | "FAILED" | "CANCELLED" | null = null;
          if (state === "COMPLETED") status = "COMPLETED";
          else if (state.startsWith("CANCELLED")) status = "CANCELLED";
          else if (state && state !== "RUNNING" && state !== "PENDING") status = "FAILED";
          // No accounting available — treat a clean watcher exit as COMPLETED
          // so the job doesn't stay stuck in RUNNING forever.
          else if (assumedComplete) status = "COMPLETED";

          // Only touch status when sacct gave us a terminal state — otherwise
          // leave whatever the DB already has and just save the captured output.
          const data: Record<string, unknown> = {};
          if (status) {
            data.status = status;
            data.exitCode = exitCode;
          }
          if (captured.length > 0) data.output = captured.join("\n");
          if (Object.keys(data).length > 0) {
            await prisma.job.update({ where: { id: jobId }, data }).catch(() => {});
          }

          send({
            type: "complete",
            success: status === "COMPLETED",
            payload: { state, exitCode },
          });
          try { controller.close(); } catch {}
        },
      });
    },
  });
}
