/**
 * Public v1 job detail endpoint.
 *
 *   GET /api/v1/jobs/:id              — metadata only
 *   GET /api/v1/jobs/:id?output=1     — metadata + last 1 MB of the Slurm
 *                                       stdout file, fetched over SSH
 *
 * The id is the DB uuid (`Job.id`), not the Slurm job id. Use the list
 * endpoint to discover ids by cluster / name.
 *
 * Non-ADMIN callers may only read their own jobs.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";
import { getApiUser } from "@/lib/api-auth";

interface RouteParams { params: Promise<{ id: string }> }

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
      exitCode: true,
      sourceName: true,
      sourceRef: true,
      createdAt: true,
      updatedAt: true,
      script: true,
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (user.role !== "ADMIN" && job.userId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const wantsOutput = new URL(req.url).searchParams.get("output") === "1";
  if (!wantsOutput) return NextResponse.json({ job });

  // Fetch the last 1 MB of stdout on-demand over SSH. Keep the payload
  // bounded so the API doesn't become a log firehose.
  const cluster = await prisma.cluster.findUnique({
    where: { id: job.clusterId },
    include: { sshKey: true },
  });
  if (!cluster || cluster.connectionMode !== "SSH" || !cluster.sshKey || !job.slurmJobId) {
    return NextResponse.json({ job, output: null, outputSize: 0 });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const M = `__V1_OUT_${Date.now()}__`;
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

echo "${M}_TAIL_START"
[ -n "$OUT" ] && [ -f "$OUT" ] && tail -c 1048576 "$OUT" 2>/dev/null
echo "${M}_TAIL_END"
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
  const output = extract("TAIL");

  return NextResponse.json({ job, output, outputSize });
}
