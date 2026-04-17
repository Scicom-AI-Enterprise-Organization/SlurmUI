import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string; jobId: string }> }

// GET /api/clusters/[id]/jobs/[jobId]/output — fetch Slurm stdout file on-demand.
// If Job.output is already persisted, returns that; otherwise SSHs to the
// controller and cats the StdOut file. Result is saved back to Job.output.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.clusterId !== id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if ((session.user as any).role !== "ADMIN" && job.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (job.output) {
    return NextResponse.json({ output: job.output, source: "db" });
  }
  if (!job.slurmJobId) {
    return NextResponse.json({ output: "", source: "none" });
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
JOBID=${job.slurmJobId}

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

echo "__AURA_OUT_START__"
if [ -n "$OUTFILE" ] && [ -f "$OUTFILE" ]; then
  # Cap at 5 MB so we don't blow up the browser
  tail -c 5242880 "$OUTFILE"
else
  echo "(output file not found for job $JOBID)"
fi
echo "__AURA_OUT_END__"
`;

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, remoteScript, {
      onStream: (line) => chunks.push(line),
      onComplete: () => resolve(),
    });
  });

  const full = chunks.join("\n");
  const startIdx = full.indexOf("__AURA_OUT_START__");
  const endIdx = full.indexOf("__AURA_OUT_END__");
  const output = startIdx !== -1 && endIdx !== -1
    ? full.slice(startIdx + "__AURA_OUT_START__".length, endIdx).replace(/^\n/, "").replace(/\n$/, "")
    : "";

  if (output && (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED")) {
    await prisma.job.update({ where: { id: jobId }, data: { output } }).catch(() => {});
  }

  return NextResponse.json({ output, source: "ssh" });
}
