import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple } from "@/lib/ssh-exec";

interface RouteParams {
  params: Promise<{ id: string }>;
}

type Kind =
  | "scontrol-job"      // scontrol show job -dd <id>
  | "sacct-job"         // sacct -j <id> --format=... -p
  | "sdiag"             // sdiag
  | "sprio"             // sprio -l -o ...
  | "sshare"            // sshare -a -P
  | "qos"               // sacctmgr -P show qos
  | "sinfo-reasons"     // sinfo -R
  | "sinfo-partitions"  // sinfo -o "%P %a %l %D %t %N"
  | "queue";            // squeue -o "..." (pending + running with reason)

const SACCT_FORMAT = [
  "JobID", "JobName", "State", "ExitCode", "DerivedExitCode", "Reason",
  "Submit", "Start", "End", "Elapsed", "Timelimit",
  "AllocCPUS", "AllocTRES", "ReqMem", "MaxRSS", "MaxVMSize", "AveCPU",
  "NodeList", "Partition", "QOS", "User",
].join(",");

const SPRIO_FORMAT = "%.15i %.9u %.10Y %.10A %.10F %.10J %.10P %.10Q %.10N";
const SQUEUE_FORMAT = "%i|%P|%u|%T|%r|%S|%L|%D|%C|%m|%Q|%V|%R";

function build(kind: Kind, jobId?: string): string | null {
  switch (kind) {
    case "scontrol-job":
      if (!jobId) return null;
      return `scontrol show job -dd ${shellEscape(jobId)} 2>&1`;
    case "sacct-job":
      if (!jobId) return null;
      return `sacct -j ${shellEscape(jobId)} -P --format=${SACCT_FORMAT} 2>&1`;
    case "sdiag":
      return `sdiag 2>&1`;
    case "sprio":
      return `sprio -l -o "${SPRIO_FORMAT}" 2>&1 | head -500`;
    case "sshare":
      return `sshare -a -P 2>&1 | head -500`;
    case "qos":
      return `sacctmgr -P show qos format=Name,Priority,MaxJobsPU,MaxSubmitPU,MaxWall,MaxTRESPU,MaxTRESPJ,GrpTRES 2>&1`;
    case "sinfo-reasons":
      return `sinfo -R -o "%20E %9u %19H %N" 2>&1`;
    case "sinfo-partitions":
      return `sinfo -h -o "%P|%a|%l|%D|%t|%N" 2>&1`;
    case "queue":
      return `squeue -h -o "${SQUEUE_FORMAT}" 2>&1 | head -1000`;
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { kind: Kind; jobId?: string };
  const cmd = build(body.kind, body.jobId);
  if (!cmd) return NextResponse.json({ error: "invalid kind or missing jobId" }, { status: 400 });

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey) {
    return NextResponse.json({ error: "cluster or ssh key not found" }, { status: 404 });
  }

  const result = await sshExecSimple(
    {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
    },
    cmd,
  );

  return NextResponse.json({
    success: result.success,
    output: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    kind: body.kind,
    jobId: body.jobId,
    fetchedAt: new Date().toISOString(),
  });
}
