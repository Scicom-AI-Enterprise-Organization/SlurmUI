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
    include: { user: { select: { id: true, email: true, name: true, unixUid: true, unixGid: true, unixUsername: true } } },
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
      // $AURA_UID is expanded by the outer controller bash (injects the
      // actual numeric UID); $S and $(id -u) stay literal so they expand
      // on the worker side via the \$ escapes.
      return `
echo "  Replicating to ${w.hostname} (${w.ip})..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${w.ip} "AURA_UID=$AURA_UID; S=''; [ \\"\\$(id -u)\\" != '0' ] && S='sudo'; if \\$S getent group ${username} >/dev/null 2>&1; then \\$S groupmod -g \\$AURA_UID ${username} 2>/dev/null || true; else \\$S groupadd -g \\$AURA_UID ${username}; fi; if \\$S id -u ${username} >/dev/null 2>&1; then \\$S usermod -u \\$AURA_UID -g \\$AURA_UID ${username} 2>/dev/null || true; else \\$S useradd -u \\$AURA_UID -g \\$AURA_UID -d ${nfsHome} -M -s /bin/bash ${username}; fi; echo '  done on ${w.hostname}'" 2>&1 | sed 's/^/    /'`;
    }).join("\n");

    const script = `#!/bin/bash
set +e
# Trace line lets the bastion-mode ssh layer close the session as soon as
# the script finishes, instead of waiting on the 30 s idle fallback.
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

echo "============================================"
echo "  Provisioning user: ${username}"
echo "  Proposed UID/GID: ${unixUid}/${unixGid}"
echo "  NFS home: ${nfsHome}"
echo "  Workers: ${workers.length}"
echo "============================================"
echo ""

S=""; [ "$(id -u)" != "0" ] && S="sudo"

# Step 0: decide the actual UID. If the proposed UID is already held by a
# DIFFERENT user (ghost from a failed deprovision, or just a collision),
# probe for the next free UID in 10000-20000 and use that. The final UID
# is exported as AURA_UID for every useradd call below AND surfaced to
# the API via the AURA_ACTUAL_UID marker so the DB can be updated.
AURA_UID=${unixUid}
EXISTING_OWNER=\$($S getent passwd \$AURA_UID 2>/dev/null | cut -d: -f1)
if [ -n "\$EXISTING_OWNER" ] && [ "\$EXISTING_OWNER" != "${username}" ]; then
  echo "  [warn] UID \$AURA_UID already owned by '\$EXISTING_OWNER' — picking next free UID"
  NEXT_UID=\$($S awk -F: 'BEGIN{m=10000}{if(\$3>m && \$3<20000)m=\$3}END{print m+1}' /etc/passwd)
  while $S getent passwd \$NEXT_UID >/dev/null 2>&1; do NEXT_UID=\$((NEXT_UID+1)); done
  AURA_UID=\$NEXT_UID
  echo "  [info] Using UID/GID \$AURA_UID instead"
fi
# Emit marker for the route handler to parse and update user.unixUid in DB
echo "__AURA_ACTUAL_UID__=\$AURA_UID"
export AURA_UID

echo "[aura] Creating group on controller"
if $S getent group ${username} >/dev/null 2>&1; then
  $S groupmod -g \$AURA_UID ${username} 2>/dev/null || true
else
  $S groupadd -g \$AURA_UID ${username}
fi

echo "[aura] Creating user on controller"
if $S id -u ${username} >/dev/null 2>&1; then
  $S usermod -u \$AURA_UID -g \$AURA_UID ${username} 2>/dev/null || true
else
  $S useradd -u \$AURA_UID -g \$AURA_UID -d ${nfsHome} -M -s /bin/bash ${username}
fi

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
      // If the controller rejected the proposed UID (ghost from a failed
      // deprovision, or collision with another user), the script picks a
      // fresh UID and emits __AURA_ACTUAL_UID__=<n>. Capture it so the DB
      // ends up in sync with what actually got created on the hosts.
      let actualUid: number | null = null;
      const uidMarkerRe = /^__AURA_ACTUAL_UID__=(\d+)$/;
      sshExecScript(target, script, {
        onStream: (line) => {
          const trimmed = line.replace(/\r/g, "").trim();
          const m = trimmed.match(uidMarkerRe);
          if (m) {
            actualUid = parseInt(m[1], 10);
            return; // don't pollute the log with the marker itself
          }
          if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
            appendLog(task.id, trimmed);
          }
        },
        onComplete: async (success) => {
          if (success) {
            if (actualUid !== null && actualUid !== unixUid) {
              // UID collision — the script used `actualUid` on all hosts.
              // Sync the DB so future flows (job submit, deprovision, NFS
              // home permissions) use the right numbers.
              await prisma.user.update({
                where: { id: userId },
                data: { unixUid: actualUid, unixGid: actualUid },
              });
              await appendLog(task.id, `[aura] Note: UID ${unixUid} was in use — assigned ${actualUid} instead (DB updated).`);
            }
            await prisma.clusterUser.update({
              where: { userId_clusterId: { userId, clusterId: id } },
              data: { status: "ACTIVE", provisionedAt: new Date() },
            });
            await appendLog(task.id, `\n[aura] User ${username} provisioned successfully.`);
            await logAudit({ action: "user.provision", entity: "Cluster", entityId: id, metadata: { userId, username, mode: "ssh", unixUid: actualUid ?? unixUid } });
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
