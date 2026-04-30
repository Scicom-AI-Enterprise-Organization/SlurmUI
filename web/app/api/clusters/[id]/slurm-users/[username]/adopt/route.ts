/**
 * POST /api/clusters/[id]/slurm-users/[username]/adopt
 *
 * Body: { userId: string }
 *
 * Link an existing Linux/Slurm account on the controller to an Aura User
 * that hasn't been provisioned yet. Used to recover from situations where
 * the controller already has the account (e.g. created out of band, or
 * surviving an Aura DB wipe) but Aura's DB doesn't track it — the cluster
 * Users tab shows the row as "unmanaged" until adopted.
 *
 * What this does:
 *   1. Verifies the Linux user actually exists on the controller (`getent
 *      passwd`). Otherwise admins could write garbage into User.unixUsername.
 *   2. Writes unixUsername / unixUid / unixGid into the target Aura User row.
 *   3. Upserts a ClusterUser link with status=ACTIVE + provisionedAt=now.
 *
 * What this DOES NOT do:
 *   - Create / modify / delete the Linux account on the controller. This is
 *     a pure DB-side adoption — the controller is read-only here.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple, getClusterSshTarget } from "@/lib/ssh-exec";
import { logAudit } from "@/lib/audit";

interface RouteParams { params: Promise<{ id: string; username: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id, username } = await params;
  const session = await auth();
  if (!session?.user || (session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(username)) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const { userId } = body as { userId?: string };
  if (!userId || typeof userId !== "string") {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (cluster.connectionMode !== "SSH" || !cluster.sshKey) {
    return NextResponse.json({ error: "Adopt is only available for SSH-mode clusters" }, { status: 412 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return NextResponse.json({ error: "Aura user not found" }, { status: 404 });

  // Refuse to overwrite an already-set unixUsername if it differs — that
  // would silently change which Linux account this Aura user maps to. The
  // explicit fix is to deprovision first.
  if (user.unixUsername && user.unixUsername !== username) {
    return NextResponse.json({
      error: `Aura user is already linked to Linux account '${user.unixUsername}'. Deprovision them first if you want to re-link.`,
    }, { status: 409 });
  }

  // Verify the username actually exists on the controller and grab its
  // uid/gid. Single round-trip via getent, no fallbacks — if the controller
  // doesn't know the user, refuse to lie about it.
  const target = await getClusterSshTarget(id);
  if (!target) return NextResponse.json({ error: "No SSH target" }, { status: 412 });
  const tgt = { ...target, bastion: cluster.sshBastion };
  const r = await sshExecSimple(tgt, `getent passwd ${username}`);
  if (!r.success || !r.stdout.trim()) {
    return NextResponse.json({
      error: `Linux user '${username}' not found on controller.`,
      detail: (r.stderr || r.stdout || "").slice(0, 400),
    }, { status: 404 });
  }
  const parts = r.stdout.trim().split("\n")[0].split(":");
  // passwd format: name:passwd:uid:gid:gecos:home:shell
  if (parts.length < 7) {
    return NextResponse.json({ error: "Unexpected getent output" }, { status: 502 });
  }
  const uid = parseInt(parts[2], 10);
  const gid = parseInt(parts[3], 10);
  if (!Number.isFinite(uid) || !Number.isFinite(gid)) {
    return NextResponse.json({ error: "Unparseable uid/gid from getent" }, { status: 502 });
  }

  // If some OTHER Aura user already claims this unixUsername, refuse —
  // unique constraint on User.unixUsername will catch it on the write
  // path, but a clearer error message helps.
  const collision = await prisma.user.findFirst({
    where: { unixUsername: username, NOT: { id: userId } },
    select: { id: true, email: true },
  });
  if (collision) {
    return NextResponse.json({
      error: `Linux account '${username}' is already linked to Aura user ${collision.email}.`,
    }, { status: 409 });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { unixUsername: username, unixUid: uid, unixGid: gid },
  });

  // Upsert the ClusterUser link as ACTIVE — admin is asserting the user
  // is already fully provisioned on this cluster.
  await prisma.clusterUser.upsert({
    where: { userId_clusterId: { userId, clusterId: id } },
    update: { status: "ACTIVE", provisionedAt: new Date() },
    create: { userId, clusterId: id, status: "ACTIVE", provisionedAt: new Date() },
  });

  await logAudit({
    action: "user.adopt",
    entity: "Cluster",
    entityId: id,
    metadata: { userId, username, uid, gid },
  });

  return NextResponse.json({
    ok: true,
    user: { id: userId, unixUsername: username, unixUid: uid, unixGid: gid },
  });
}
