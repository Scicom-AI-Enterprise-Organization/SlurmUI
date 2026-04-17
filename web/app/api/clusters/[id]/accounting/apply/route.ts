import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";

interface RouteParams { params: Promise<{ id: string }> }

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

// POST /api/clusters/[id]/accounting/apply
//   body: { mode: "none" | "slurmdbd" }
//   - "none"     → strip AccountingStorageType / AccountingStorageEnforce,
//                  set AccountingStorageType=accounting_storage/none, restart slurmctld.
//   - "slurmdbd" → install + start MariaDB and slurmdbd, set AccountingStorageType
//                  to slurmdbd, register cluster account, then re-register ACTIVE
//                  cluster users so their accounts land in the DB.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const mode: "none" | "slurmdbd" | "fifo" =
    body.mode === "slurmdbd" ? "slurmdbd" :
    body.mode === "fifo" ? "fifo" : "none";

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const taskType =
    mode === "fifo" ? "priority_fifo" : `accounting_${mode}`;
  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: taskType },
  });

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  // Collect active cluster users so we can re-register them when enabling slurmdbd.
  const clusterUsers = await prisma.clusterUser.findMany({
    where: { clusterId: id, status: "ACTIVE" },
    include: { user: { select: { unixUsername: true, email: true } } },
  });
  const usernames = clusterUsers
    .map((cu) => cu.user.unixUsername ?? cu.user.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase())
    .filter(Boolean);

  const clusterSlurmName = (cluster.config as Record<string, unknown>).slurm_cluster_name as string ?? "aura-cluster";

  const scriptDisable = `#!/bin/bash
set -euo pipefail
S=""; [ "$(id -u)" != "0" ] && S="sudo"

echo "============================================"
echo "  Disabling Slurm accounting"
echo "============================================"

CONF=/etc/slurm/slurm.conf
if [ ! -f "$CONF" ]; then
  echo "[error] $CONF not found — run Bootstrap first"
  exit 1
fi

echo "[aura] Current AccountingStorageType lines:"
$S grep -n '^AccountingStorage' "$CONF" || echo "  (none)"

$S sed -i '/^AccountingStorageType=/d;/^AccountingStorageEnforce=/d;/^AccountingStorageHost=/d;/^AccountingStoragePass=/d;/^AccountingStorageUser=/d;/^AccountingStoragePort=/d;/^AccountingStorageLoc=/d' "$CONF"
echo "AccountingStorageType=accounting_storage/none" | $S tee -a "$CONF" > /dev/null

echo ""
echo "[aura] After:"
$S grep -n '^AccountingStorage' "$CONF"

echo ""
echo "[aura] Restarting slurmctld..."
$S systemctl restart slurmctld 2>&1 | tail -5 || true
sleep 2
$S systemctl is-active slurmctld && echo "[aura] slurmctld is active" || echo "[aura] slurmctld NOT active"

echo ""
echo "[aura] Done. Jobs submit without account enforcement."
`;

  const userRegs = usernames.map((u) => `
$S sacctmgr -i add account ${u} Description="Aura user ${u}" Organization=Aura Cluster=${clusterSlurmName} 2>&1 | tail -5 || true
$S sacctmgr -i add user ${u} Account=${u} DefaultAccount=${u} 2>&1 | tail -5 || true
`).join("\n");

  const scriptEnable = `#!/bin/bash
set -euo pipefail
S=""; [ "$(id -u)" != "0" ] && S="sudo"

echo "============================================"
echo "  Enabling Slurm accounting (slurmdbd + MariaDB)"
echo "============================================"

CONF=/etc/slurm/slurm.conf
if [ ! -f "$CONF" ]; then
  echo "[error] $CONF not found — run Bootstrap first"
  exit 1
fi

echo "[aura] Installing MariaDB + slurmdbd..."
export DEBIAN_FRONTEND=noninteractive
$S apt-get update -qq 2>&1 | tail -3
$S apt-get install -y -qq mariadb-server slurmdbd 2>&1 | tail -3

echo "[aura] Starting MariaDB..."
$S systemctl enable --now mariadb 2>&1 | tail -3
sleep 2

DBPASS=$(head -c 24 /dev/urandom | base64 | tr -d '=+/' | head -c 24)
echo "[aura] Creating slurm_acct_db + user (password reset each run)..."
# ALTER USER ensures the password matches even if the user pre-exists from a
# previous failed apply. Otherwise CREATE USER IF NOT EXISTS silently skips
# the password, slurmdbd fails MariaDB auth, and dies after systemd "active".
$S mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS slurm_acct_db;
CREATE USER IF NOT EXISTS 'slurm'@'localhost' IDENTIFIED BY '$DBPASS';
ALTER USER 'slurm'@'localhost' IDENTIFIED BY '$DBPASS';
GRANT ALL ON slurm_acct_db.* TO 'slurm'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "[aura] Writing slurmdbd.conf..."
$S bash -c "cat > /etc/slurm/slurmdbd.conf" <<SLURMDBD_EOF
AuthType=auth/munge
DbdHost=localhost
DbdPort=6819
SlurmUser=slurm
DebugLevel=info
LogFile=/var/log/slurm/slurmdbd.log
PidFile=/run/slurmdbd.pid
StorageType=accounting_storage/mysql
StorageHost=localhost
StoragePort=3306
StorageUser=slurm
StoragePass=$DBPASS
StorageLoc=slurm_acct_db
SLURMDBD_EOF
$S chown slurm:slurm /etc/slurm/slurmdbd.conf
$S chmod 600 /etc/slurm/slurmdbd.conf

echo "[aura] Starting slurmdbd..."
$S systemctl restart slurmdbd 2>&1 | tail -3 || true
$S systemctl enable slurmdbd 2>&1 | tail -3 || true
sleep 5

echo "[aura] Verifying slurmdbd is actually listening on 6819..."
# systemctl is-active can lie if the process died right after start. Check the
# port directly — sacctmgr talks to it, so we need a real listener.
for i in $(seq 1 10); do
  if $S ss -ltn 2>/dev/null | grep -q ':6819 ' || $S netstat -ltn 2>/dev/null | grep -q ':6819 '; then
    echo "  slurmdbd listening on 6819"
    break
  fi
  if [ $i -eq 10 ]; then
    echo "[error] slurmdbd is not listening on 6819 after 10s. Last 30 log lines:"
    $S journalctl -u slurmdbd -n 30 --no-pager 2>&1 | sed 's/^/    /' || \
      $S tail -30 /var/log/slurm/slurmdbd.log 2>&1 | sed 's/^/    /' || true
    echo ""
    echo "[hint] Most common causes:"
    echo "  - MariaDB auth mismatch (try clicking Enable again — we now ALTER the password each run)"
    echo "  - munge not set up on this host"
    exit 1
  fi
  sleep 1
done

echo "[aura] Patching slurm.conf to use slurmdbd..."
$S sed -i '/^AccountingStorageType=/d;/^AccountingStorageEnforce=/d;/^AccountingStorageHost=/d' "$CONF"
$S bash -c "cat >> $CONF" <<SLURM_ACCT_EOF
AccountingStorageType=accounting_storage/slurmdbd
AccountingStorageHost=localhost
AccountingStorageEnforce=associations
SLURM_ACCT_EOF

echo "[aura] Restarting slurmctld..."
$S systemctl restart slurmctld 2>&1 | tail -5
sleep 3

echo "[aura] Registering cluster '${clusterSlurmName}' in sacctmgr..."
$S sacctmgr -i add cluster ${clusterSlurmName} 2>&1 | tail -5 || true

echo "[aura] Registering ${usernames.length} user(s)..."
${userRegs}

echo ""
echo "[aura] Registered users:"
$S sacctmgr -s list user 2>&1 | head -40

echo ""
echo "[aura] Done. slurmdbd running, accounts created."
`;

  const scriptFifo = `#!/bin/bash
set -euo pipefail
S=""; [ "$(id -u)" != "0" ] && S="sudo"

echo "============================================"
echo "  Switching to FIFO priority scheduling"
echo "============================================"

CONF=/etc/slurm/slurm.conf
if [ ! -f "$CONF" ]; then
  echo "[error] $CONF not found — run Bootstrap first"
  exit 1
fi

echo "[aura] Current scheduler config:"
$S grep -nE '^PriorityType=|^SchedulerType=' "$CONF" || echo "  (defaults)"

$S sed -i '/^PriorityType=/d' "$CONF"
echo "PriorityType=priority/basic" | $S tee -a "$CONF" > /dev/null

echo ""
echo "[aura] After:"
$S grep -nE '^PriorityType=' "$CONF"

echo ""
echo "[aura] Restarting slurmctld..."
$S systemctl restart slurmctld 2>&1 | tail -5 || true
sleep 2
$S systemctl is-active slurmctld && echo "[aura] slurmctld is active" || echo "[aura] slurmctld NOT active"

echo ""
echo "[aura] Done. Jobs are now ordered FIFO — no fair-share math."
`;

  const script =
    mode === "fifo" ? scriptFifo :
    mode === "none" ? scriptDisable : scriptEnable;

  (async () => {
    await appendLog(task.id, `[aura] Applying accounting mode: ${mode}`);
    const handle = sshExecScript(target, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          await appendLog(task.id, `\n[aura] Accounting mode "${mode}" applied successfully.`);
          await logAudit({
            action: "cluster.accounting",
            entity: "Cluster",
            entityId: id,
            metadata: { mode, users: usernames.length },
          });
        } else {
          await appendLog(task.id, "\n[aura] Accounting change failed or was cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id });
}
