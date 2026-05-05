import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string; jobId: string }> }

// GET /api/clusters/[id]/jobs/[jobId]/info — scontrol/sinfo diagnostics
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { clusterId: true, userId: true, slurmJobId: true, partition: true },
  });
  if (!job || job.clusterId !== id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if ((session.user as any).role !== "ADMIN" && job.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!job.slurmJobId) {
    return NextResponse.json({ error: "No Slurm job ID" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey || cluster.connectionMode !== "SSH") {
    return NextResponse.json({ error: "Not available for this cluster" }, { status: 412 });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const part = job.partition || "";
  const script = `#!/bin/bash
set +e

echo "__AURA_INFO_START__"

echo "__SECTION__=scontrol"
scontrol show job -dd ${job.slurmJobId} 2>&1

echo "__SECTION__=sacct"
sacct -j ${job.slurmJobId} -P --format=JobID,JobName,State,ExitCode,DerivedExitCode,Reason,Submit,Start,End,Elapsed,Timelimit,AllocCPUS,AllocTRES,ReqMem,MaxRSS,MaxVMSize,AveCPU,NodeList,Partition,QOS,User 2>&1

echo "__SECTION__=sprio"
sprio -j ${job.slurmJobId} -l 2>&1

echo "__SECTION__=squeue"
squeue -j ${job.slurmJobId} -o "%.18i %.9P %.8j %.8u %.2t %.10M %.6D %r %R" 2>&1

echo "__SECTION__=sinfo"
${part ? `sinfo -N -p ${part} -o "%n %P %t %c %m %G %E"` : `sinfo -N -o "%n %P %t %c %m %G %E"`} 2>&1

echo "__SECTION__=partition"
${part ? `scontrol show partition ${part}` : `scontrol show partition`} 2>&1

echo "__SECTION__=END"
echo "__AURA_INFO_END__"
`;

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => {
        if (!line.startsWith("[stderr]")) chunks.push(line);
      },
      onComplete: () => resolve(),
    });
  });

  // Strip bastion welcome banner / shell prompt / command echo that lands in
  // the stream before our script actually runs.
  const full = chunks.join("\n");
  const startIdx = full.indexOf("__AURA_INFO_START__");
  const endIdx = full.indexOf("__AURA_INFO_END__");
  const body = startIdx !== -1 && endIdx !== -1
    ? full.slice(startIdx + "__AURA_INFO_START__".length, endIdx)
    : full;

  const sections: Record<string, string> = {};
  const parts = body.split(/__SECTION__=/);
  for (const chunk of parts) {
    const nl = chunk.indexOf("\n");
    if (nl === -1) continue;
    const name = chunk.slice(0, nl).trim();
    const content = chunk.slice(nl + 1);
    if (name && name !== "END") sections[name] = content.replace(/^\n+|\n+$/g, "");
  }

  return NextResponse.json({ sections });
}
