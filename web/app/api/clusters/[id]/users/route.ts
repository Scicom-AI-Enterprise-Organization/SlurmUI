import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";
import { logAudit } from "@/lib/audit";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

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

// GET /api/clusters/[id]/users — list provisioned users
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const clusterUsers = await prisma.clusterUser.findMany({
    where: { clusterId: id },
    include: { user: { select: { id: true, email: true, name: true, unixUid: true, unixGid: true } } },
    orderBy: { provisionedAt: "desc" },
  });

  return NextResponse.json(clusterUsers);
}

// POST /api/clusters/[id]/users — provision a user to this cluster
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
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (cluster.status !== "ACTIVE") {
    return NextResponse.json({ error: "Cluster must be ACTIVE to provision users" }, { status: 409 });
  }

  const { userId } = await req.json();
  if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const existing = await prisma.clusterUser.findUnique({
    where: { userId_clusterId: { userId, clusterId: id } },
  });
  if (existing && existing.status === "ACTIVE") {
    return NextResponse.json({ error: "User already provisioned to this cluster" }, { status: 409 });
  }

  let { unixUid, unixGid } = user;
  if (!unixUid) {
    const updated = await prisma.$transaction(async (tx) => {
      const maxResult = await tx.user.aggregate({ _max: { unixUid: true } });
      const newUid = (maxResult._max.unixUid ?? 9999) + 1;
      return tx.user.update({
        where: { id: userId },
        data: { unixUid: newUid, unixGid: newUid },
      });
    });
    unixUid = updated.unixUid!;
    unixGid = updated.unixGid!;
  }

  await prisma.clusterUser.upsert({
    where: { userId_clusterId: { userId, clusterId: id } },
    create: { userId, clusterId: id, status: "PENDING" },
    update: { status: "PENDING", provisionedAt: null },
  });

  const config = cluster.config as Record<string, unknown>;
  const controllerHost = cluster.controllerHost;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const workers = hostsEntries.filter((h) => h.hostname !== controllerHost);

  const dataNfsPath = (config.data_nfs_path as string) ?? "/aura-usrdata";
  const username = user.unixUsername
    ?? user.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const nfsHome = `${dataNfsPath}/${username}`;

  if (!user.unixUsername) {
    await prisma.user.update({ where: { id: userId }, data: { unixUsername: username } });
  }

  // SSH mode: background task
  if (cluster.connectionMode === "SSH") {
    if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

    const task = await prisma.backgroundTask.create({
      data: { clusterId: id, type: "provision_user" },
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
echo "  Replicating to ${w.hostname} (${w.ip})..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${w.ip} bash -s <<'NODE_EOF'
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"
$S getent group ${username} >/dev/null 2>&1 || $S groupadd -g ${unixGid} ${username}
$S id -u ${username} >/dev/null 2>&1 || $S useradd -u ${unixUid} -g ${unixGid} -d ${nfsHome} -M -s /bin/bash ${username}
echo "  done on ${w.hostname}"
NODE_EOF`;
    }).join("\n");

    const script = `#!/bin/bash
set +e

echo "============================================"
echo "  Provisioning user: ${username}"
echo "  UID/GID: ${unixUid}/${unixGid}"
echo "  NFS home: ${nfsHome}"
echo "  Workers: ${workers.length}"
echo "============================================"
echo ""

S=""; [ "$(id -u)" != "0" ] && S="sudo"

echo "[aura] Creating group on controller"
$S getent group ${username} >/dev/null 2>&1 || $S groupadd -g ${unixGid} ${username}

echo "[aura] Creating user on controller"
$S id -u ${username} >/dev/null 2>&1 || $S useradd -u ${unixUid} -g ${unixGid} -d ${nfsHome} -M -s /bin/bash ${username}

echo "[aura] Creating NFS home dir: ${nfsHome}"
$S mkdir -p ${nfsHome}
$S chown ${unixUid}:${unixGid} ${nfsHome}
$S chmod 700 ${nfsHome}

if [ ! -f ${nfsHome}/.bashrc ]; then
  $S bash -c "cat > ${nfsHome}/.bashrc <<BASHRC
# .bashrc
export HOME=${nfsHome}
export USER=${username}
export PATH=\\\$PATH:/usr/local/bin:/usr/bin:/bin
[ -f /etc/bashrc ] && . /etc/bashrc
BASHRC"
  $S chown ${unixUid}:${unixGid} ${nfsHome}/.bashrc
fi
if [ ! -f ${nfsHome}/.bash_profile ]; then
  $S bash -c "cat > ${nfsHome}/.bash_profile <<'BASHPROF'
# .bash_profile
[ -f ~/.bashrc ] && . ~/.bashrc
BASHPROF"
  $S chown ${unixUid}:${unixGid} ${nfsHome}/.bash_profile
fi

echo "[aura] Registering with Slurm accounting (optional)"
$S sacctmgr -i add account ${username} Description="Aura user ${username}" Organization=Aura 2>&1 | grep -v "^$" | head -5 || true
$S sacctmgr -i add user ${username} Account=${username} 2>&1 | grep -v "^$" | head -5 || true

${workerBlock}

echo ""
echo "[aura] User ${username} provisioned (uid=${unixUid})"
`;

    (async () => {
      await appendLog(task.id, `[aura] Provisioning user ${username} (uid=${unixUid})`);
      sshExecScript(target, script, {
        onStream: (line) => {
          const trimmed = line.replace(/\r/g, "").trim();
          if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
            appendLog(task.id, trimmed);
          }
        },
        onComplete: async (success) => {
          if (success) {
            await prisma.clusterUser.update({
              where: { userId_clusterId: { userId, clusterId: id } },
              data: { status: "ACTIVE", provisionedAt: new Date() },
            });
            await appendLog(task.id, `\n[aura] User ${username} provisioned successfully.`);
            await logAudit({ action: "user.provision", entity: "Cluster", entityId: id, metadata: { userId, username, mode: "ssh" } });
          } else {
            await prisma.clusterUser.update({
              where: { userId_clusterId: { userId, clusterId: id } },
              data: { status: "FAILED" },
            });
            await appendLog(task.id, "\n[aura] User provisioning failed.");
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
    type: "provision_user",
    payload: {
      username,
      uid: unixUid,
      gid: unixGid,
      nfs_home: nfsHome,
      worker_hosts: workerHosts,
    },
  });

  return NextResponse.json({ request_id: requestId });
}
