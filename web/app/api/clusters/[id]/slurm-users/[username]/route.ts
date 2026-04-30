/**
 * DELETE /api/clusters/[id]/slurm-users/[username]
 *
 * Deprovision a Linux/Slurm user keyed by their controller-side username,
 * NOT by an Aura User row id. Used for "unmanaged" entries — accounts that
 * exist on the controller (`getent passwd` / `sacctmgr show user`) but have
 * no Aura DB row, typically because they were created out-of-band or
 * because the Aura DB was wiped after provisioning.
 *
 * The "managed" delete path lives at /clusters/[id]/users/[userId] and
 * keeps the ClusterUser row consistent. This unmanaged path skips Prisma
 * entirely and only runs userdel + sacctmgr delete on the cluster.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";
import { publishCommand } from "@/lib/nats";
import { logAudit } from "@/lib/audit";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string; username: string }> }

interface HostEntry {
  hostname: string;
  ip: string;
  user?: string;
  port?: number;
}

async function appendLog(taskId: string, line: string) {
  try {
    await prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${line + "\n"} WHERE id = ${taskId}`;
  } catch {}
}

async function finishTask(taskId: string, success: boolean) {
  await prisma.backgroundTask.update({
    where: { id: taskId },
    data: { status: success ? "success" : "failed", completedAt: new Date() },
  });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id, username } = await params;
  const session = await auth();
  if (!session?.user || (session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Defense-in-depth: usernames from `getent passwd` are alphanumeric +
  // underscore + dash + dot. Anything else means we're being asked to
  // smuggle shell metacharacters into `userdel`.
  if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(username)) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const workers = hostsEntries.filter((h) => h.hostname !== cluster.controllerHost);
  const dataNfsPath = (config.data_nfs_path as string) ?? "/aura-usrdata";
  const nfsHome = `${dataNfsPath}/${username}`;

  // If a matching Aura User row exists (by unixUsername), flag any active
  // ClusterUser link as REMOVED so the managed view doesn't get out of sync.
  // We don't make this required — the whole point is to handle drift.
  const dbUser = await prisma.user.findFirst({ where: { unixUsername: username }, select: { id: true } });
  if (dbUser) {
    await prisma.clusterUser.updateMany({
      where: { userId: dbUser.id, clusterId: id, status: { not: "REMOVED" } },
      data: { status: "REMOVED" },
    });
  }

  if (cluster.connectionMode === "SSH") {
    if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

    const task = await prisma.backgroundTask.create({
      data: { clusterId: id, type: "deprovision_user" },
    });

    const target = {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
    };

    const workerBlock = workers.map((w) => {
      const u = w.user || "root";
      const p = w.port || 22;
      return `
echo "  Removing from ${w.hostname} (${w.ip})..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${w.ip} bash -s <<'NODE_EOF'
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"
$S userdel ${username} 2>/dev/null || true
$S groupdel ${username} 2>/dev/null || true
echo "  done on ${w.hostname}"
NODE_EOF`;
    }).join("\n");

    const script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

echo "============================================"
echo "  Deprovisioning unmanaged user: ${username}"
echo "  NFS home (preserved): ${nfsHome}"
echo "============================================"
echo ""

S=""; [ "$(id -u)" != "0" ] && S="sudo"

echo "[aura] Removing Slurm accounting records"
$S sacctmgr -i delete user Name=${username} 2>&1 | head -3 || true
$S sacctmgr -i delete account Name=${username} 2>&1 | head -3 || true

echo "[aura] Removing user from controller"
$S userdel ${username} 2>/dev/null || true
$S groupdel ${username} 2>/dev/null || true

${workerBlock}

echo ""
echo "[aura] User ${username} deprovisioned (NFS home preserved)"
`;

    (async () => {
      await appendLog(task.id, `[aura] Deprovisioning unmanaged user ${username}`);
      sshExecScript(target, script, {
        onStream: (line) => {
          const trimmed = line.replace(/\r/g, "").trim();
          if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
            appendLog(task.id, trimmed);
          }
        },
        onComplete: async (success) => {
          if (success) {
            await appendLog(task.id, `\n[aura] User ${username} deprovisioned successfully.`);
            await logAudit({ action: "user.deprovision_unmanaged", entity: "Cluster", entityId: id, metadata: { username, mode: "ssh" } });
          } else {
            await appendLog(task.id, "\n[aura] User deprovisioning failed.");
          }
          await finishTask(task.id, success);
        },
      });
    })();

    return NextResponse.json({ taskId: task.id });
  }

  // NATS mode — same payload shape the regular DELETE uses; agent handles it.
  const workerHosts = workers.map((h) => ({ hostname: h.hostname, ip: h.ip }));
  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "deprovision_user",
    payload: {
      username,
      uid: 0,
      gid: 0,
      nfs_home: nfsHome,
      worker_hosts: workerHosts,
    },
  });
  await logAudit({ action: "user.deprovision_unmanaged", entity: "Cluster", entityId: id, metadata: { username, mode: "nats" } });
  return NextResponse.json({ request_id: requestId });
}
