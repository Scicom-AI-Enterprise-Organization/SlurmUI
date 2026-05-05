import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string; jobId: string }> }

// GET /api/clusters/[id]/jobs/[jobId]/output — fetch Slurm stdout file on-demand.
//
// Query params (optional): ?offset=<bytes>&limit=<bytes>
//   - When either is present, range mode is used: the request goes over SSH,
//     the DB cache is bypassed, and the response is NOT persisted back to
//     Job.output. Clients use this to page through logs longer than the
//     default 5 MB cap or to resync a DB-cached output that has since grown
//     on disk.
//   - When absent, legacy behaviour: return Job.output if cached, else SSH
//     and return the last 5 MB (and cache on terminal status).
//
// Response always includes `size` (total file size on disk in bytes) when
// obtained via SSH. For range requests, `offset` and `returned` report the
// actual byte window served.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Select only the columns we touch — the cached `output` column on this
  // row can be hundreds of KB to a few MB on jobs with verbose logging
  // (vLLM debug, etc.), and pulling it in just to authorise the request
  // wastes the same memory the endpoint is about to allocate again from
  // the SSH read.
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, clusterId: true, userId: true, slurmJobId: true, status: true },
  });
  if (!job || job.clusterId !== id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if ((session.user as any).role !== "ADMIN" && job.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const offsetParam = url.searchParams.get("offset");
  const limitParam = url.searchParams.get("limit");
  const rangeMode = offsetParam !== null || limitParam !== null;
  // Keep the default tail small so a noisy debug log can't blow the
  // request heap on the first paint. The UI pages older content via
  // explicit ?offset=&limit= when the user scrolls.
  const DEFAULT_CAP = 256 * 1024;
  const MAX_LIMIT = 50 * 1024 * 1024;
  const offset = Math.max(0, Number.parseInt(offsetParam ?? "0", 10) || 0);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.parseInt(limitParam ?? String(DEFAULT_CAP), 10) || DEFAULT_CAP),
  );

  // Note: we deliberately no longer short-circuit on Job.output. The cached
  // value is frozen at write-time, so if the log keeps growing post-write
  // (common with long-running post-processing) the UI would silently show a
  // stale snapshot. Always hit SSH so we can report the real on-disk size;
  // the DB cache is still maintained as a fallback on write.
  if (!job.slurmJobId) {
    return NextResponse.json({ output: "", source: "none", size: 0, offset: 0, returned: 0 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey) {
    return NextResponse.json({ error: "Cluster not reachable" }, { status: 412 });
  }
  if (cluster.connectionMode !== "SSH") {
    return NextResponse.json({ output: "", source: "none" });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const remoteScript = `#!/bin/bash
set +e
# Emit the trace line on exit so the bastion-mode ssh layer closes the
# session immediately instead of waiting on its 30s idle fallback. Every
# poll would otherwise take 30+ seconds.
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT
JOBID=${job.slurmJobId}
RANGE_MODE=${rangeMode ? 1 : 0}
OFFSET=${offset}
LIMIT=${limit}

# Resolve StdOut path from scontrol (running/recent) or sacct (older jobs)
OUTFILE=$(scontrol show job $JOBID 2>/dev/null | grep -oP 'StdOut=\\K[^ ]+' | head -1)
if [ -z "$OUTFILE" ] || [ "$OUTFILE" = "(null)" ]; then
  WORKDIR=$(sacct -j $JOBID -n -o WorkDir%-500 2>/dev/null | head -1 | xargs)
  if [ -n "$WORKDIR" ]; then
    for candidate in "$WORKDIR/slurm-$JOBID.out" "$WORKDIR/slurm-$JOBID.log"; do
      if [ -f "$candidate" ]; then OUTFILE="$candidate"; break; fi
    done
  fi
fi

# Resolve the compute node running the job. Reading through NFS on the
# controller hides buffered writes the job process hasn't flushed yet, so
# the size + content we see there lag badly behind reality. Hopping to the
# actual compute node gives us the writer-local view (same as "cat" on the
# node) and matches what the user expects.
NODE=$(scontrol show job $JOBID 2>/dev/null | grep -oP 'BatchHost=\\K[^ ]+' | head -1)
if [ -z "$NODE" ] || [ "$NODE" = "(null)" ]; then
  NODE=$(squeue -j $JOBID -h -o '%B' 2>/dev/null | head -1)
fi

read_remote() {
  # $1 = bash command to run on the compute node
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
      -o LogLevel=ERROR -o BatchMode=yes -o ConnectTimeout=5 \\
      "$NODE" "$1" 2>/dev/null
}

SIZE=0
if [ -n "$OUTFILE" ]; then
  if [ -n "$NODE" ]; then
    SIZE=$(read_remote "stat -c %s '$OUTFILE' 2>/dev/null || wc -c < '$OUTFILE' 2>/dev/null || echo 0")
  fi
  # Fallback: read through the local (NFS) mount on the controller. Use
  # wc -c — it forces a full read, which revalidates NFS attrs and gives
  # the real size, unlike a bare stat.
  if [ -z "$SIZE" ] || [ "$SIZE" = "0" ]; then
    if [ -f "$OUTFILE" ]; then
      SIZE=$(wc -c < "$OUTFILE" 2>/dev/null || echo 0)
    fi
  fi
fi
echo "__AURA_SIZE__=$SIZE"
echo "__AURA_OUT_START__"
if [ -n "$OUTFILE" ]; then
  if [ "$RANGE_MODE" = "1" ]; then
    READ_CMD="dd if='$OUTFILE' bs=1M iflag=skip_bytes,count_bytes skip=$OFFSET count=$LIMIT status=none"
  else
    # No-range default: last $LIMIT bytes (matches DEFAULT_CAP on the JS side).
    READ_CMD="tail -c $LIMIT '$OUTFILE'"
  fi
  if [ -n "$NODE" ]; then
    read_remote "$READ_CMD"
  elif [ -f "$OUTFILE" ]; then
    eval "$READ_CMD"
  else
    echo "(output file not found for job $JOBID)"
  fi
else
  echo "(output file not found for job $JOBID)"
fi
echo "__AURA_OUT_END__"
`;

  // Timing instrumentation — emits per-stage durations into the response
  // so the UI can render a collapsible "debug" panel. Also console.log'd
  // when AURA_OUTPUT_DEBUG=1 is set for server-side inspection.
  const serverDebug = process.env.AURA_OUTPUT_DEBUG === "1";
  const t0 = Date.now();
  const marks: Array<{ stage: string; ms: number }> = [];
  const mark = (stage: string) => {
    const ms = Date.now() - t0;
    marks.push({ stage, ms });
    if (serverDebug) console.log(`[output job=${jobId.slice(0, 8)} slurm=${job.slurmJobId}] +${ms}ms ${stage}`);
  };
  mark(`begin (range=${rangeMode} off=${offset} lim=${limit} bastion=${!!target.bastion})`);

  const chunks: string[] = [];
  let firstChunkAt: number | null = null;
  await new Promise<void>((resolve) => {
    sshExecScript(target, remoteScript, {
      onStream: (line) => {
        if (firstChunkAt === null) { firstChunkAt = Date.now() - t0; mark("first stdout line"); }
        chunks.push(line);
      },
      onComplete: () => { mark("ssh complete"); resolve(); },
    });
  });

  const full = chunks.join("\n");
  const startIdx = full.indexOf("__AURA_OUT_START__");
  const endIdx = full.indexOf("__AURA_OUT_END__");
  const output = startIdx !== -1 && endIdx !== -1
    ? full.slice(startIdx + "__AURA_OUT_START__".length, endIdx).replace(/^\n/, "").replace(/\n$/, "")
    : "";
  const sizeMatch = full.match(/__AURA_SIZE__=(\d+)/);
  const size = sizeMatch ? Number.parseInt(sizeMatch[1], 10) : 0;
  const returned = Buffer.byteLength(output, "utf8");
  mark(`parsed (size=${size} returned=${returned} chunks=${chunks.length} rawBytes=${Buffer.byteLength(full, "utf8")})`);

  // Only cache in the DB when we know we have the full file (legacy path,
  // and returned length covers the whole size). Range requests never cache
  // — the cached value is meant to be "the whole log" for completed jobs.
  const terminal = job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED";
  if (!rangeMode && output && terminal && size > 0 && returned >= size) {
    await prisma.job.update({ where: { id: jobId }, data: { output } }).catch(() => {});
    mark("cached to db");
  }

  mark("done");
  return NextResponse.json({
    output,
    source: "ssh",
    size,
    offset: rangeMode ? offset : Math.max(0, size - returned),
    returned,
    debug: marks,
  });
}
