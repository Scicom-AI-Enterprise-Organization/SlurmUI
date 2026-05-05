import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string; jobId: string }> }

// GET /api/clusters/[id]/jobs/[jobId]/stderr — fetch Slurm StdErr file on demand.
// If StdErr is merged with StdOut (common default), returns a hint instead.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { clusterId: true, userId: true, slurmJobId: true },
  });
  if (!job || job.clusterId !== id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if ((session.user as any).role !== "ADMIN" && job.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!job.slurmJobId) {
    return NextResponse.json({ stderr: "", source: "none" });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey || cluster.connectionMode !== "SSH") {
    return NextResponse.json({ stderr: "", source: "none" });
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
JOBID=${job.slurmJobId}

ERRFILE=$(scontrol show job $JOBID 2>/dev/null | grep -oP 'StdErr=\\K[^ ]+' | head -1)
OUTFILE=$(scontrol show job $JOBID 2>/dev/null | grep -oP 'StdOut=\\K[^ ]+' | head -1)

echo "__AURA_ERR_START__"
if [ -n "$ERRFILE" ] && [ "$ERRFILE" != "(null)" ] && [ "$ERRFILE" != "$OUTFILE" ] && [ -f "$ERRFILE" ]; then
  echo "__MERGED__=no"
  tail -c 2097152 "$ERRFILE"
elif [ -n "$ERRFILE" ] && [ "$ERRFILE" = "$OUTFILE" ]; then
  echo "__MERGED__=yes"
else
  echo "__MERGED__=unknown"
fi
echo "__AURA_ERR_END__"
`;

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, remoteScript, {
      onStream: (line) => chunks.push(line),
      onComplete: () => resolve(),
    });
  });

  const full = chunks.join("\n");
  const s = full.indexOf("__AURA_ERR_START__");
  const e = full.indexOf("__AURA_ERR_END__");
  if (s === -1 || e === -1) {
    return NextResponse.json({ stderr: "", merged: "unknown" });
  }
  const body = full.slice(s + "__AURA_ERR_START__".length, e).replace(/^\n/, "").replace(/\n$/, "");
  const mergedMatch = body.match(/__MERGED__=(\w+)/);
  const merged = mergedMatch ? mergedMatch[1] : "unknown";
  const stderr = body.replace(/__MERGED__=\w+\n?/, "");
  return NextResponse.json({ stderr, merged });
}
