import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

// GET — detect current accounting mode by grepping slurm.conf + slurmdbd state.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey) {
    return NextResponse.json({ error: "Cluster not reachable" }, { status: 412 });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const marker = `__ACCT_${Date.now()}__`;
  const script = `#!/bin/bash
set +e
echo "${marker}_START"
grep -E '^AccountingStorageType=|^AccountingStorageEnforce=|^PriorityType=' /etc/slurm/slurm.conf 2>/dev/null || echo "NO_CONF"
echo "DBD_ACTIVE=$(systemctl is-active slurmdbd 2>/dev/null)"
echo "${marker}_END"
`;

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });

  const full = chunks.join("\n");
  const startIdx = full.indexOf(`${marker}_START`);
  const endIdx = full.indexOf(`${marker}_END`);
  const body = startIdx !== -1 && endIdx !== -1
    ? full.slice(startIdx + `${marker}_START`.length, endIdx)
    : full;

  const typeMatch = body.match(/AccountingStorageType=(\S+)/);
  const enforceMatch = body.match(/AccountingStorageEnforce=(\S+)/);
  const priorityMatch = body.match(/PriorityType=(\S+)/);
  const dbdActive = /DBD_ACTIVE=active/.test(body);

  const type = typeMatch ? typeMatch[1] : "accounting_storage/none";
  const mode: "none" | "slurmdbd" | "unknown" =
    type.endsWith("/none") ? "none" :
    type.endsWith("/slurmdbd") ? "slurmdbd" : "unknown";

  const latestTask = await prisma.backgroundTask.findFirst({
    where: { clusterId: id, OR: [{ type: "accounting_none" }, { type: "accounting_slurmdbd" }] },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, type: true, createdAt: true },
  });

  const priority = priorityMatch ? priorityMatch[1] : "priority/multifactor";
  return NextResponse.json({
    mode,
    type,
    enforce: enforceMatch ? enforceMatch[1] : null,
    priority,
    slurmdbdActive: dbdActive,
    healthy: mode === "none" || (mode === "slurmdbd" && dbdActive),
    latestTask,
  });
}
