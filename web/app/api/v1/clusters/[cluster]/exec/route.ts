/**
 * Run an arbitrary shell command on the cluster controller.
 *
 * Bearer-auth + admin only. Same shape as POST /api/clusters/[id]/exec but
 * Bearer-token authenticated so the dev loop can probe ad-hoc state.
 *
 *   curl -X POST -H "Authorization: Bearer aura_…" \
 *     -H "Content-Type: application/json" \
 *     -d '{"command":"stat -c %U:%G:%a /var/lib/munge"}' \
 *     http://localhost:3000/api/v1/clusters/<id>/exec
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ cluster: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { cluster: id } = await params;

  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const command = typeof body.command === "string" ? body.command : "";
  if (!command) {
    return NextResponse.json({ error: "command is required" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
    proxyCommand: cluster.sshProxyCommand,
    jumpProxyCommand: cluster.sshJumpProxyCommand,
  };

  const start = Date.now();
  const r = await sshExecSimple(target, command);
  const durationMs = Date.now() - start;

  return NextResponse.json({
    clusterId: id,
    clusterName: cluster.name,
    command,
    success: r.success,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    durationMs,
  }, { status: r.success ? 200 : 200 }); // 200 either way — caller checks success
}
