import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";
import { logAudit } from "@/lib/audit";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string; userId: string }> }

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

// PATCH /api/clusters/[id]/users/[userId] — update provisioning status after SSE reply
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, userId } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { status } = await req.json();
  if (!["ACTIVE", "FAILED"].includes(status)) {
    return NextResponse.json({ error: "status must be ACTIVE or FAILED" }, { status: 400 });
  }

  const clusterUser = await prisma.clusterUser.update({
    where: { userId_clusterId: { userId, clusterId: id } },
    data: {
      status,
      provisionedAt: status === "ACTIVE" ? new Date() : undefined,
    },
  });

  return NextResponse.json(clusterUser);
}

// DELETE /api/clusters/[id]/users/[userId] — deprovision a user from this cluster
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id, userId } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const clusterUser = await prisma.clusterUser.findUnique({
    where: { userId_clusterId: { userId, clusterId: id } },
  });
  if (!clusterUser) return NextResponse.json({ error: "User not provisioned on this cluster" }, { status: 404 });
  if (clusterUser.status === "REMOVED") {
    return NextResponse.json({ error: "User already removed" }, { status: 409 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  await prisma.clusterUser.update({
    where: { userId_clusterId: { userId, clusterId: id } },
    data: { status: "REMOVED" },
  });

  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const workers = hostsEntries.filter((h) => h.hostname !== cluster.controllerHost);
  const dataNfsPath = (config.data_nfs_path as string) ?? "/aura-usrdata";
  const username = user.unixUsername ?? user.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const nfsHome = `${dataNfsPath}/${username}`;

  // SSH mode: background task
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
# Trace line lets the bastion-mode ssh layer close the session as soon as
# the script finishes, instead of waiting on the 30 s idle fallback.
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

echo "============================================"
echo "  Deprovisioning user: ${username}"
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
      await appendLog(task.id, `[aura] Deprovisioning user ${username}`);
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
            await logAudit({ action: "user.deprovision", entity: "Cluster", entityId: id, metadata: { userId, username, mode: "ssh" } });
          } else {
            await appendLog(task.id, "\n[aura] User deprovisioning failed.");
          }
          await finishTask(task.id, success);
        },
      });
    })();

    return NextResponse.json({ taskId: task.id });
  }

  // NATS mode
  const workerHosts = workers.map((h) => ({ hostname: h.hostname, ip: h.ip }));
  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "deprovision_user",
    payload: {
      username,
      uid: user.unixUid ?? 0,
      gid: user.unixGid ?? 0,
      nfs_home: nfsHome,
      worker_hosts: workerHosts,
    },
  });

  return NextResponse.json({ request_id: requestId });
}
