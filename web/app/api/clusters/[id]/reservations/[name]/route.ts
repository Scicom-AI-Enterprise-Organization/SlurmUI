import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";
import { logAudit } from "@/lib/audit";

interface RouteParams { params: Promise<{ id: string; name: string }> }

// DELETE /api/clusters/[id]/reservations/[name]
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id, name } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return NextResponse.json({ error: "Invalid reservation name" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey || cluster.connectionMode !== "SSH") {
    return NextResponse.json({ error: "Not available for this cluster" }, { status: 412 });
  }

  const marker = `__RES_DEL_${Date.now()}__`;
  const script = `#!/bin/bash
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"
echo "${marker}_START"
$S scontrol delete reservation=${name} 2>&1
ec=$?
echo "${marker}_END:$ec"
`;

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };
  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });
  const blob = chunks.join("\n");
  const s = blob.indexOf(`${marker}_START`);
  const endMatch = blob.match(new RegExp(`${marker}_END:(\\d+)`));
  const exit = endMatch ? parseInt(endMatch[1], 10) : null;
  const eIdx = endMatch ? blob.indexOf(endMatch[0]) : -1;
  const out = s !== -1 && eIdx !== -1
    ? blob.slice(s + marker.length + 6, eIdx).trim()
    : blob.trim();

  await logAudit({
    action: "reservation.delete",
    entity: "Cluster",
    entityId: id,
    metadata: { name, success: exit === 0 },
  });

  if (exit !== 0) {
    return NextResponse.json({ error: out || "scontrol failed" }, { status: 400 });
  }
  return NextResponse.json({ deleted: name, output: out });
}
