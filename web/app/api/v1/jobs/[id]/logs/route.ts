/**
 * GET /api/v1/jobs/:id/logs — fetch a job's Slurm stdout file via SSH.
 *
 *   GET /api/v1/jobs/:id/logs
 *   GET /api/v1/jobs/:id/logs?bytes=131072      # last 128 KiB instead of 1 MiB
 *   GET /api/v1/jobs/:id/logs?bytes=4194304     # last 4 MiB (max 16 MiB)
 *   GET /api/v1/jobs/:id/logs?head=1            # first `bytes` bytes instead
 *                                                 of last
 *
 * Returns:
 *   {
 *     job:        { id, slurmJobId, status, partition, updatedAt },
 *     output:     "...",     // requested slice of stdout
 *     outputSize: 449436,    // total file size on disk
 *     returned:   1048576,   // bytes in `output`
 *     truncated:  true,      // outputSize > returned
 *     source:     "ssh"      // always "ssh" today; "db" reserved for future
 *                            // cached-tail fallback
 *   }
 *
 * Non-ADMIN callers may only read their own jobs.
 *
 * Auth: Bearer aura_* (any role for own jobs; ADMIN for all). Same shape as
 * the other /api/v1/jobs/:id/* endpoints. Use this instead of
 * `GET /api/v1/jobs/:id?output=1` when you want to control how much is
 * returned or pull the head of the file (e.g. to see the SBATCH preamble
 * + early errors instead of just the live tail).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";
import { getApiUser } from "@/lib/api-auth";

interface RouteParams { params: Promise<{ id: string }> }

const DEFAULT_BYTES = 1 * 1024 * 1024;   // 1 MiB
const MAX_BYTES = 16 * 1024 * 1024;       // 16 MiB hard cap

export async function GET(req: NextRequest, { params }: RouteParams) {
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      id: true,
      slurmJobId: true,
      clusterId: true,
      userId: true,
      partition: true,
      status: true,
      updatedAt: true,
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (user.role !== "ADMIN" && job.userId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const rawBytes = parseInt(url.searchParams.get("bytes") ?? "", 10);
  const bytes = Number.isFinite(rawBytes) && rawBytes > 0
    ? Math.min(rawBytes, MAX_BYTES)
    : DEFAULT_BYTES;
  const head = url.searchParams.get("head") === "1";

  const cluster = await prisma.cluster.findUnique({
    where: { id: job.clusterId },
    include: { sshKey: true },
  });
  if (!cluster || cluster.connectionMode !== "SSH" || !cluster.sshKey) {
    return NextResponse.json({
      job,
      output: "",
      outputSize: 0,
      returned: 0,
      truncated: false,
      source: "ssh",
      error: "No SSH connection configured for this cluster",
    }, { status: 412 });
  }
  if (!job.slurmJobId) {
    return NextResponse.json({
      job,
      output: "",
      outputSize: 0,
      returned: 0,
      truncated: false,
      source: "ssh",
      error: "Job has no Slurm id yet",
    });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
    proxyCommand: cluster.sshProxyCommand,
    jumpProxyCommand: cluster.sshJumpProxyCommand,
  };

  // Resolve the output file via scontrol then sacct (same logic as
  // /api/v1/jobs/:id?output=1 — kept inline here so the two endpoints can
  // evolve independently without coupling).
  const M = `__V1_LOGS_${Date.now()}__`;
  const sliceCmd = head ? `head -c ${bytes}` : `tail -c ${bytes}`;
  const script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

JOBID=${job.slurmJobId}
OUT=$(scontrol show job $JOBID 2>/dev/null | grep -oP 'StdOut=\\K[^ ]+' | head -1)
if [ -z "$OUT" ] || [ "$OUT" = "(null)" ]; then
  WD=$(sacct -j $JOBID -n -o WorkDir%-500 2>/dev/null | head -1 | xargs)
  [ -n "$WD" ] && OUT="$WD/slurm-$JOBID.out"
fi

echo "${M}_SIZE_START"
[ -n "$OUT" ] && [ -f "$OUT" ] && wc -c < "$OUT" 2>/dev/null || echo 0
echo "${M}_SIZE_END"

echo "${M}_SLICE_START"
[ -n "$OUT" ] && [ -f "$OUT" ] && ${sliceCmd} "$OUT" 2>/dev/null
echo "${M}_SLICE_END"
`;

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      timeoutMs: 30 * 1000,
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });
  const full = chunks.join("\n");
  const extract = (s: string) => {
    const a = full.indexOf(`${M}_${s}_START`);
    const b = full.indexOf(`${M}_${s}_END`);
    return a !== -1 && b !== -1
      ? full.slice(a + `${M}_${s}_START`.length, b).replace(/^\n/, "").replace(/\n$/, "")
      : "";
  };
  const outputSize = parseInt(extract("SIZE").trim(), 10) || 0;
  const output = extract("SLICE");
  const returned = Buffer.byteLength(output, "utf8");

  return NextResponse.json({
    job,
    output,
    outputSize,
    returned,
    truncated: outputSize > returned,
    source: "ssh",
  });
}
