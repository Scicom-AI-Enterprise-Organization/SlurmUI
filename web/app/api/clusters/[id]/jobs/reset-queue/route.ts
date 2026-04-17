import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

// POST /api/clusters/[id]/jobs/reset-queue
// Cancels the caller's PENDING jobs on the cluster. Useful for clearing out
// zombie jobs left over from misconfigured accounting or bad submits.
export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });
  if (cluster.connectionMode !== "SSH") {
    return NextResponse.json({ error: "Reset only supported in SSH mode" }, { status: 400 });
  }

  const dbUser = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const username = dbUser.unixUsername ?? dbUser.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase();

  const isAdmin = (session.user as any).role === "ADMIN";

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const marker = `__RESET_${Date.now()}__`;
  // Admins clear every user's PENDING jobs; normal users only their own.
  // scancel only lets the job owner or root cancel — the SSH user usually
  // owns neither, so route through sudo so root does it.
  const scancelCmd = isAdmin
    ? `scancel --state=PENDING`
    : `scancel -u ${username} --state=PENDING`;
  const script = `#!/bin/bash
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"
echo "${marker}_START"
echo "[aura] Queue before:"
squeue -h -o '%.8i %.9P %.8u %.2t %R' | head -50
echo ""
echo "[aura] Running: $S ${scancelCmd}"
$S ${scancelCmd} 2>&1 | head -20
echo ""
echo "[aura] Queue after:"
squeue -h -o '%.8i %.9P %.8u %.2t %R' | head -50
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
    ? full.slice(startIdx + `${marker}_START`.length, endIdx).trim()
    : full;

  // Mark our DB rows CANCELLED for pending jobs belonging to this user on
  // this cluster. Admins clear everyone's.
  const where: any = { clusterId: id, status: "PENDING" };
  if (!isAdmin) where.userId = session.user.id;
  const updated = await prisma.job.updateMany({
    where,
    data: { status: "CANCELLED" },
  });

  await logAudit({
    action: "jobs.reset_queue",
    entity: "Cluster",
    entityId: id,
    metadata: { scope: isAdmin ? "all" : "self", dbCancelled: updated.count },
  });

  return NextResponse.json({ output: body, dbCancelled: updated.count });
}
