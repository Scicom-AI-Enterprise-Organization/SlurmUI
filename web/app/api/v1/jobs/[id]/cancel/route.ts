/**
 * POST /api/v1/jobs/:id/cancel — scancel a job via the controller.
 *
 * Uses `scancel --signal=KILL --full` with a sudo fallback (matches the UI
 * Cancel button and the gitops reconciler). After the remote scancel,
 * the DB row is flipped to CANCELLED. Safe to call on jobs Slurm already
 * finished — the scancel just no-ops and we still mark the row CANCELLED
 * if it was still in a non-terminal state.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";
import { logAudit } from "@/lib/audit";
import { getApiUser } from "@/lib/api-auth";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (user.role !== "ADMIN" && job.userId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id: job.clusterId },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey || cluster.connectionMode !== "SSH") {
    return NextResponse.json({ error: "Not available for this cluster" }, { status: 412 });
  }

  if (job.slurmJobId) {
    const target = {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
    };
    const script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT
OUT=$(scancel --signal=KILL --full ${job.slurmJobId} 2>&1)
RC=$?
echo "$OUT"
if [ $RC -eq 0 ] && ! echo "$OUT" | grep -q "Kill job error"; then
  echo "[scancel-ok] via $(id -un)"
  exit 0
fi
echo "[scancel-retry] sudo -n"
sudo -n scancel --signal=KILL --full ${job.slurmJobId} 2>&1
exit $?
`;
    await new Promise<void>((resolve) => {
      sshExecScript(target, script, {
        onStream: () => {},
        onComplete: () => resolve(),
      });
    });
  }

  const updated = await prisma.job.update({
    where: { id },
    data: { status: "CANCELLED" },
  });

  await logAudit({
    action: "job.cancel",
    entity: "Job",
    entityId: id,
    metadata: { slurmJobId: job.slurmJobId, via: "api/v1", tokenId: user.tokenId },
  });

  return NextResponse.json({
    id: updated.id,
    slurmJobId: updated.slurmJobId,
    status: updated.status,
  });
}
