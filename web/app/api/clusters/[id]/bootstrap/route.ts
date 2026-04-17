import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface HostEntry {
  hostname: string;
  ip: string;
  port?: number;
}

interface ClusterSsh {
  host: string;
  user: string;
  port: number;
  sshKeyFile?: string;
}

function buildInventory(clusterSsh: ClusterSsh, config: Record<string, unknown>): string {
  const controllerHost = config.slurm_controller_host as string;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const workerEntries = hostsEntries.filter((h) => h.hostname !== controllerHost);

  const keyArg = clusterSsh.sshKeyFile ? ` ansible_ssh_private_key_file=${clusterSsh.sshKeyFile}` : "";

  const controllerLine = `${controllerHost} ansible_host=${clusterSsh.host} ansible_user=${clusterSsh.user} ansible_port=${clusterSsh.port} ansible_python_interpreter=/usr/bin/python3${keyArg}`;

  const workerLines = workerEntries
    .map((h) => {
      const user = (h as any).user || clusterSsh.user;
      const port = (h as any).port || 22;
      return `${h.hostname} ansible_host=${h.ip} ansible_user=${user} ansible_port=${port} ansible_python_interpreter=/usr/bin/python3${keyArg}`;
    })
    .join("\n");

  return `[slurm_controllers]\n${controllerLine}\n\n[slurm_workers]\n${workerLines}\n`;
}

function buildBootstrapScript(): string {
  return `#!/bin/bash
set -euo pipefail

S=""
if [ "$(id -u)" != "0" ]; then S="sudo"; fi

echo ""
echo "============================================"
echo "  Aura Cluster Bootstrap"
echo "============================================"
echo ""

echo "[1/8] System information..."
echo "  Hostname:  $(hostname)"
echo "  OS:        $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '"' || uname -s)"
echo "  Kernel:    $(uname -r)"
echo "  CPU cores: $(nproc 2>/dev/null || echo unknown)"
echo "  Memory:    $(free -h 2>/dev/null | awk '/^Mem:/{print \$2}' || echo unknown)"
echo "  User:      $(whoami)"
echo ""

echo "[2/8] Installing system prerequisites..."
export DEBIAN_FRONTEND=noninteractive
$S apt-get update -qq 2>&1 | tail -3
$S apt-get install -y -qq curl wget gnupg2 software-properties-common python3 python3-pip nfs-kernel-server nfs-common munge libmunge-dev mariadb-server libmariadb-dev chrony build-essential 2>&1 | grep -E "^(Setting up|already the newest)" | head -20 || true
echo "  Prerequisites installed"
echo ""

echo "[3/8] Configuring Munge..."
if [ ! -f /etc/munge/munge.key ]; then
  $S bash -c 'create-munge-key -f 2>/dev/null || dd if=/dev/urandom bs=1 count=1024 > /etc/munge/munge.key 2>/dev/null'
  echo "  Generated new munge key"
else
  echo "  Munge key already exists"
fi
$S chown munge:munge /etc/munge/munge.key 2>/dev/null || true
$S chmod 400 /etc/munge/munge.key
$S systemctl enable munge 2>/dev/null || true
$S systemctl restart munge
echo "  Munge configured and running"
echo ""

echo "[4/8] Configuring MariaDB for Slurm accounting..."
$S systemctl enable mariadb 2>/dev/null || true
$S systemctl start mariadb
$S mysql -e "CREATE DATABASE IF NOT EXISTS slurm_acct_db;" 2>/dev/null || true
$S mysql -e "CREATE USER IF NOT EXISTS 'slurm'@'localhost' IDENTIFIED BY 'slurm_password';" 2>/dev/null || true
$S mysql -e "GRANT ALL ON slurm_acct_db.* TO 'slurm'@'localhost';" 2>/dev/null || true
$S mysql -e "FLUSH PRIVILEGES;" 2>/dev/null || true
echo "  MariaDB configured"
echo ""

echo "[5/8] Installing Slurm..."
if ! command -v slurmctld &>/dev/null; then
  $S apt-get install -y -qq slurm-wlm slurm-client 2>&1 | tail -5 || echo "  Slurm package not found in apt"
fi
if command -v slurmctld &>/dev/null; then
  echo "  Slurm installed: $(slurmctld --version 2>/dev/null || echo unknown)"
else
  echo "  WARNING: Slurm not found after install attempt"
fi
echo ""

echo "[6/8] Configuring Slurm..."
$S mkdir -p /etc/slurm /var/spool/slurmctld /var/spool/slurmd /var/log/slurm
$S chown slurm:slurm /var/spool/slurmctld /var/spool/slurmd /var/log/slurm 2>/dev/null || true

if [ ! -f /etc/slurm/slurm.conf ]; then
  HOSTNAME=$(hostname -s)
  $S bash -c "cat > /etc/slurm/slurm.conf << 'SLURM_CONF'
ClusterName=aura-cluster
SlurmctldHost=$HOSTNAME
MpiDefault=none
ProctrackType=proctrack/linuxproc
ReturnToService=2
SlurmctldPidFile=/run/slurmctld.pid
SlurmctldPort=6817
SlurmdPidFile=/run/slurmd.pid
SlurmdPort=6818
SlurmdSpoolDir=/var/spool/slurmd
SlurmUser=slurm
StateSaveLocation=/var/spool/slurmctld
SwitchType=switch/none
TaskPlugin=task/none
SchedulerType=sched/backfill
SelectType=select/cons_tres
GresTypes=gpu
SlurmctldLogFile=/var/log/slurm/slurmctld.log
SlurmdLogFile=/var/log/slurm/slurmd.log
SLURM_CONF"
  echo "  Generated minimal slurm.conf"
else
  echo "  slurm.conf already exists"
fi
echo ""

echo "[7/8] Starting Slurm services..."
$S systemctl enable slurmctld 2>/dev/null || true
$S systemctl restart slurmctld 2>/dev/null && echo "  slurmctld started" || echo "  WARNING: slurmctld failed to start"
echo ""

echo "[8/8] Configuring Chrony (time sync)..."
$S systemctl enable chronyd 2>/dev/null || $S systemctl enable chrony 2>/dev/null || true
$S systemctl restart chronyd 2>/dev/null || $S systemctl restart chrony 2>/dev/null || true
echo "  Chrony configured"
echo ""

echo "============================================"
echo "  Bootstrap complete!"
echo "  Controller: $(hostname)"
echo "  Slurm: $(slurmctld --version 2>/dev/null || echo 'not installed')"
echo "============================================"
`;
}

// Append a line to the task logs in DB
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

// Run bastion bootstrap in background
function runBastionBootstrap(taskId: string, clusterId: string, cluster: any) {
  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: true,
  };

  const script = buildBootstrapScript();

  appendLog(taskId, `[aura] Bootstrapping cluster: ${cluster.name} (bastion mode)`);
  appendLog(taskId, `[aura] Connecting to ${target.user}@${target.host}...`);
  appendLog(taskId, "");

  const handle = sshExecScript(target, script, {
    onStream: (line) => {
      const trimmed = line.replace(/\r/g, "").trim();
      if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
        appendLog(taskId, trimmed);
      }
    },
    onComplete: async (success) => {
      if (success) {
        await prisma.cluster.update({ where: { id: clusterId }, data: { status: "ACTIVE" } });
        await appendLog(taskId, "\n[aura] Bootstrap completed successfully. Cluster is now ACTIVE.");
        logAudit({ action: "cluster.bootstrap", entity: "Cluster", entityId: clusterId, metadata: { name: cluster.name, mode: "bastion" } });
      } else {
        await appendLog(taskId, "\n[aura] Bootstrap failed or was cancelled.");
      }
      await finishTask(taskId, success);
    },
  });
  registerRunningTask(taskId, handle);
}

// Run Ansible bootstrap in background
function runAnsibleBootstrap(taskId: string, clusterId: string, cluster: any, config: Record<string, unknown>) {
  if (process.env.AURA_AGENT_BINARY_SRC) {
    config = { ...config, aura_agent_binary_src: process.env.AURA_AGENT_BINARY_SRC };
  }

  const playbookDir = process.env.ANSIBLE_PLAYBOOKS_DIR ?? "/opt/aura/ansible";
  const playbookFile = process.env.ANSIBLE_PLAYBOOK ?? "bootstrap.yml";

  let tmpDir: string | null = null;

  try {
    tmpDir = mkdtempSync(join(tmpdir(), "aura-bootstrap-"));
    const inventoryPath = join(tmpDir, "inventory.ini");
    const configPath = join(tmpDir, "cluster-config.json");

    let sshKeyFile: string | undefined;
    if (cluster.sshKey) {
      sshKeyFile = join(tmpDir, "ssh_key");
      writeFileSync(sshKeyFile, cluster.sshKey.privateKey, { mode: 0o600 });
    }

    writeFileSync(inventoryPath, buildInventory({
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      sshKeyFile,
    }, config));
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    appendLog(taskId, `[aura] Starting bootstrap for cluster: ${cluster.name}`);
    appendLog(taskId, `[aura] Running: ansible-playbook ${playbookFile}`);
    appendLog(taskId, "");

    const proc = spawn("ansible-playbook", [
      "-i", inventoryPath,
      "-e", `@${configPath}`,
      "--diff",
      join(playbookDir, playbookFile),
    ], {
      env: {
        ...process.env,
        ANSIBLE_FORCE_COLOR: "0",
        ANSIBLE_NOCOLOR: "1",
        ANSIBLE_HOST_KEY_CHECKING: "False",
      },
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line) appendLog(taskId, line);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line) appendLog(taskId, `[stderr] ${line}`);
      }
    });

    proc.on("close", async (code) => {
      const success = code === 0;
      if (success) {
        await prisma.cluster.update({ where: { id: clusterId }, data: { status: "ACTIVE" } });
        await appendLog(taskId, "\n[aura] Bootstrap completed successfully. Cluster is now ACTIVE.");
        logAudit({ action: "cluster.bootstrap", entity: "Cluster", entityId: clusterId, metadata: { name: cluster.name, mode: "ansible" } });
      } else {
        await appendLog(taskId, `\n[aura] ansible-playbook exited with code ${code}`);
      }
      await finishTask(taskId, success);
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    proc.on("error", async (err) => {
      await appendLog(taskId, `[aura] Failed to start: ${err.message}`);
      await finishTask(taskId, false);
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });
  } catch (err) {
    appendLog(taskId, `[aura] Error: ${err instanceof Error ? err.message : "Unknown"}`);
    finishTask(taskId, false);
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  }
}

// POST /api/clusters/[id]/bootstrap — start background bootstrap
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
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key assigned" }, { status: 412 });

  // Check if already running
  const existing = await prisma.backgroundTask.findFirst({
    where: { clusterId: id, type: "bootstrap", status: "running" },
  });
  if (existing) {
    return NextResponse.json({ taskId: existing.id, alreadyRunning: true });
  }

  const body = await req.json();
  let config = (body.config ?? cluster.config) as Record<string, unknown>;
  config = { ...config, aura_cluster_id: id };

  // Create task record
  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: "bootstrap" },
  });

  // Start in background (don't await)
  if (cluster.sshBastion) {
    runBastionBootstrap(task.id, id, cluster);
  } else {
    runAnsibleBootstrap(task.id, id, cluster, config);
  }

  return NextResponse.json({ taskId: task.id });
}
