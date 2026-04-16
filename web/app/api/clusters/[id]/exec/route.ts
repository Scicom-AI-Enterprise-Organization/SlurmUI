import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecSimple } from "@/lib/ssh-exec";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/exec — execute a command on the cluster controller via SSH
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }
  if (!cluster.sshKey) {
    return NextResponse.json({ error: "No SSH key assigned to this cluster" }, { status: 412 });
  }

  const body = await req.json();
  const { command } = body;

  if (!command || typeof command !== "string") {
    return NextResponse.json({ error: "command is required" }, { status: 400 });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
  };

  const result = await sshExecSimple(target, command);

  await logAudit({
    action: "cluster.exec",
    entity: "Cluster",
    entityId: id,
    metadata: { command: command.slice(0, 200) },
  });

  return NextResponse.json({
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
}
