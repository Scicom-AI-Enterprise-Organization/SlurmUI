import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";
import { buildEnableSlurmdbdScript } from "@/lib/accounting-script";
import { randomUUID } from "crypto";
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
  // The controllerHost is usually an IP, but hostsEntries' hostname is the
  // logical Slurm node name (often different). Exclude workers whose IP OR
  // hostname matches the controller — otherwise a single-VM bootstrap loops
  // back to itself as a worker, which fails NFS self-mount.
  const workerEntries = hostsEntries.filter(
    (h) => h.hostname !== controllerHost && h.ip !== controllerHost,
  );

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

function buildBootstrapScript(seed?: {
  hostname: string;
  cpus: number;
  sockets: number;
  cores: number;
  threads: number;
  memMb: number;
  gpus: number;
  ip: string;
}): string {
  // When a pre-probed node is supplied (bastion mode preflight), render the
  // NodeName + PartitionName=main lines into slurm.conf so slurmctld starts
  // with a valid single-node cluster on its first launch. Without this the
  // controller ends up with an empty cluster and the user has to manually
  // deploy itself as a node, which bastion mode can't easily do.
  const nodeLines = seed
    ? `\nGresTypes=gpu\n\n# --- auto-seeded by bootstrap preflight ---\nNodeName=${seed.hostname} NodeAddr=${seed.ip} CPUs=${seed.cpus} Sockets=${seed.sockets} CoresPerSocket=${seed.cores} ThreadsPerCore=${seed.threads} RealMemory=${seed.memMb}${seed.gpus > 0 ? ` Gres=gpu:${seed.gpus}` : ""} State=UNKNOWN\nPartitionName=main Default=YES Nodes=${seed.hostname} MaxTime=INFINITE State=UP\n`
    : "\nGresTypes=gpu\n";
  const gresConfBlock = seed && seed.gpus > 0
    ? `
# Render gres.conf for GPU-equipped controller (required when NodeName declares Gres=gpu:N).
$S bash -c "cat > /etc/slurm/gres.conf << 'GRES_CONF'
${Array.from({ length: seed.gpus }, (_, i) => `Name=gpu File=/dev/nvidia${i}`).join("\n")}
GRES_CONF"
`
    : "";
  return `#!/bin/bash
set -euo pipefail

S=""
if [ "$(id -u)" != "0" ]; then S="sudo"; fi

echo ""
echo "============================================"
echo "  SlurmUI Cluster Bootstrap"
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
SlurmctldLogFile=/var/log/slurm/slurmctld.log
SlurmdLogFile=/var/log/slurm/slurmd.log${nodeLines}SLURM_CONF"
  echo "  Generated minimal slurm.conf"
else
  echo "  slurm.conf already exists"
fi
${gresConfBlock}
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
async function runBastionBootstrap(taskId: string, clusterId: string, cluster: any) {
  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: true,
  };

  appendLog(taskId, `[aura] Bootstrapping cluster: ${cluster.name} (bastion mode)`);
  appendLog(taskId, `[aura] Connecting to ${target.user}@${target.host}...`);
  appendLog(taskId, "");

  // Pre-probe the controller so the generated slurm.conf already contains
  // the NodeName + PartitionName=main lines on first start. In bastion mode
  // there's no reachable second host to "seed-after" like the ansible path
  // does, so we have to render the single-node cluster up front.
  let seed;
  try {
    seed = await seedControllerAsNode({
      clusterId,
      taskId,
      sshTarget: {
        host: cluster.controllerHost,
        user: cluster.sshUser,
        port: cluster.sshPort,
        privateKey: cluster.sshKey?.privateKey ?? "",
        bastion: true,
      },
    });
  } catch (e) {
    await appendLog(taskId, `[aura] Pre-probe failed: ${e instanceof Error ? e.message : "unknown"} — continuing with empty slurm.conf`);
  }

  const script = buildBootstrapScript(seed);

  const handle = sshExecScript(target, script, {
    // 30 minute watchdog — slurm install + mariadb setup + apt-get steps
    // routinely take 5-10 minutes on fresh controllers; the default 60 s
    // would SIGKILL the session mid-install. 30 min is comfortably above
    // worst-case and well below "something's truly hung, give up".
    timeoutMs: 30 * 60 * 1000,
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
        // Note: seedControllerAsNode already ran as a preflight above,
        // before the bootstrap script, so the DB + slurm.conf are already
        // in sync. No second seed call needed here.
        try {
          await autoEnableAccounting({
            clusterId,
            taskId,
            sshTarget: {
              host: cluster.controllerHost,
              user: cluster.sshUser,
              port: cluster.sshPort,
              privateKey: cluster.sshKey?.privateKey ?? "",
              bastion: cluster.sshBastion,
            },
          });
        } catch (e) {
          await appendLog(taskId, `[aura] Accounting auto-enable skipped: ${e instanceof Error ? e.message : "unknown"}`);
        }
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

        // The bootstrap playbook writes a self-registering NodeName placeholder
        // into slurm.conf (so slurmctld can start with an empty cluster config).
        // Mirror that placeholder into cluster.config so the UI "owns" the
        // controller node the same way it owns Add-Node workers — without this
        // the user has to Delete + Re-Add the controller after every bootstrap
        // to get Edit / Delete / stats to work properly on it.
        try {
          await seedControllerAsNode({
            clusterId,
            taskId,
            sshTarget: {
              host: cluster.controllerHost,
              user: cluster.sshUser,
              port: cluster.sshPort,
              privateKey: cluster.sshKey?.privateKey ?? "",
              bastion: cluster.sshBastion,
            },
          });
        } catch (e) {
          await appendLog(taskId, `[aura] Controller auto-seed skipped: ${e instanceof Error ? e.message : "unknown"}`);
        }
        try {
          await autoEnableAccounting({
            clusterId,
            taskId,
            sshTarget: {
              host: cluster.controllerHost,
              user: cluster.sshUser,
              port: cluster.sshPort,
              privateKey: cluster.sshKey?.privateKey ?? "",
              bastion: cluster.sshBastion,
            },
          });
        } catch (e) {
          await appendLog(taskId, `[aura] Accounting auto-enable skipped: ${e instanceof Error ? e.message : "unknown"}`);
        }
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

  // Start in background (don't await). `runBastionBootstrap` is async now
  // (awaits the preflight probe before kicking off the bootstrap script);
  // fire-and-forget, but surface any synchronous throw to the task log.
  if (cluster.sshBastion) {
    runBastionBootstrap(task.id, id, cluster).catch(async (e) => {
      await appendLog(task.id, `[aura] Bootstrap error: ${e instanceof Error ? e.message : "unknown"}`);
      await finishTask(task.id, false);
    });
  } else {
    runAnsibleBootstrap(task.id, id, cluster, config);
  }

  return NextResponse.json({ taskId: task.id });
}

// After bootstrap succeeds, probe the controller's hardware and seed a proper
// entry in cluster.config.slurm_nodes + slurm_hosts_entries for it. This mirrors
// what Add-Node does for workers — so after bootstrap the controller is already
// a fully-tracked node, and the user doesn't need to Delete + Re-Add it to get
// Edit / Memory / CPU stats right.
async function seedControllerAsNode(args: {
  clusterId: string;
  taskId: string;
  sshTarget: { host: string; user: string; port: number; privateKey: string; bastion: boolean };
}) {
  const { clusterId, taskId, sshTarget } = args;
  if (!sshTarget.privateKey) return;

  // Re-read the cluster so we don't clobber concurrent config edits.
  const fresh = await prisma.cluster.findUnique({ where: { id: clusterId } });
  if (!fresh) return;
  const cfg = (fresh.config ?? {}) as Record<string, unknown>;
  const hosts = (cfg.slurm_hosts_entries ?? []) as Array<Record<string, unknown>>;
  const nodes = (cfg.slurm_nodes ?? []) as Array<Record<string, unknown>>;
  // If the user (or a previous bootstrap) already seeded something, don't overwrite.
  if (nodes.length > 0) {
    await appendLog(taskId, `[aura] Controller auto-seed skipped — cluster already has ${nodes.length} node(s) configured.`);
    return;
  }

  // Probe the controller for its real hw: hostname, cpus, sockets, cores,
  // threads, memory, and an Nvidia GPU count (best-effort).
  const MARKER = `__SEED_${Date.now()}__`;
  const probe = `
echo "${MARKER}_START"
echo "hostname=$(hostname)"
echo "cpus=$(nproc --all)"
LSCPU=$(lscpu 2>/dev/null)
echo "sockets=$(echo "$LSCPU" | awk -F: '/^Socket\\(s\\):/ {gsub(/ /,"",$2); print $2}')"
echo "cores_per_socket=$(echo "$LSCPU" | awk -F: '/^Core\\(s\\) per socket:/ {gsub(/ /,"",$2); print $2}')"
echo "threads_per_core=$(echo "$LSCPU" | awk -F: '/^Thread\\(s\\) per core:/ {gsub(/ /,"",$2); print $2}')"
echo "memory_mb=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
echo "gpus=$(command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L 2>/dev/null | wc -l || echo 0)"
echo "${MARKER}_END"
`;
  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(sshTarget, probe, {
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });
  const blob = chunks.join("\n");
  const s = blob.indexOf(`${MARKER}_START`);
  const e = blob.indexOf(`${MARKER}_END`);
  if (s === -1 || e === -1) {
    await appendLog(taskId, "[aura] Controller auto-seed skipped — could not probe hardware.");
    return;
  }
  const body = blob.slice(s + MARKER.length + 6, e);
  const kv: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^([a-z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }

  const hostname = kv.hostname || sshTarget.host;
  const cpus = parseInt(kv.cpus, 10) || 1;
  const sockets = parseInt(kv.sockets, 10) || 1;
  const cores = parseInt(kv.cores_per_socket, 10) || cpus;
  const threads = parseInt(kv.threads_per_core, 10) || 1;
  const rawMemMb = parseInt(kv.memory_mb, 10) || 1024;
  // Subtract a small safety margin from MemTotal before writing it to
  // slurm.conf. slurmd will later report `reported = MemTotal/1024` on
  // registration, and slurmctld rejects with INVAL if reported < configured
  // (default MemSpecLimit=100%). /proc/meminfo can drift a few MB between
  // our probe and slurmd's registration because of kernel reclaim / slab.
  // 1% or 256 MB (whichever is smaller) keeps the configured value safely
  // under the realistic floor without wasting visible RAM on small VMs.
  const memMargin = Math.max(64, Math.min(256, Math.floor(rawMemMb * 0.01)));
  const memMb = Math.max(512, rawMemMb - memMargin);
  const gpus = parseInt(kv.gpus, 10) || 0;

  hosts.push({
    hostname,
    ip: sshTarget.host,
    user: sshTarget.user,
    port: sshTarget.port,
  });
  nodes.push({
    expression: hostname,
    ip: sshTarget.host,
    ssh_user: sshTarget.user,
    ssh_port: sshTarget.port,
    cpus,
    gpus,
    memory_mb: memMb,
    sockets,
    cores_per_socket: cores,
    threads_per_core: threads,
    role: "controller",
  });

  await prisma.cluster.update({
    where: { id: clusterId },
    data: {
      config: {
        ...cfg,
        slurm_hosts_entries: hosts,
        slurm_nodes: nodes,
      } as never,
    },
  });

  await appendLog(
    taskId,
    `[aura] Controller auto-seeded as node "${hostname}": ${cpus} CPU / ${sockets}S${cores}C${threads}T / ${memMb} MB / ${gpus} GPU`,
  );

  return { hostname, cpus, sockets, cores, threads, memMb, gpus, ip: sshTarget.host };
}

export interface BootstrapNodeSeed {
  hostname: string;
  cpus: number;
  sockets: number;
  cores: number;
  threads: number;
  memMb: number;
  gpus: number;
  ip: string;
}

// Enable slurmdbd accounting as the final step of bootstrap. Installs MariaDB
// and slurmdbd, switches slurm.conf to accounting_storage/slurmdbd, and
// persists the generated DB password to cluster.config so the next bootstrap
// doesn't undo it. Reuses an existing password if one was persisted earlier.
async function autoEnableAccounting(args: {
  clusterId: string;
  taskId: string;
  sshTarget: { host: string; user: string; port: number; privateKey: string; bastion?: any };
}): Promise<void> {
  const { clusterId, taskId, sshTarget } = args;

  const fresh = await prisma.cluster.findUnique({ where: { id: clusterId } });
  if (!fresh) return;
  const cfg = (fresh.config ?? {}) as Record<string, unknown>;

  const existingPass = (cfg.vault_slurmdbd_storage_pass as string) ?? "";
  const dbPass = existingPass && existingPass.length > 0
    ? existingPass
    : randomUUID().replace(/-/g, "");
  const clusterSlurmName = (cfg.slurm_cluster_name as string) ?? "aura-cluster";

  const clusterUsers = await prisma.clusterUser.findMany({
    where: { clusterId, status: "ACTIVE" },
    include: { user: { select: { unixUsername: true, email: true } } },
  });
  const usernames = clusterUsers
    .map((cu) => cu.user.unixUsername ?? cu.user.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase())
    .filter(Boolean);

  const script = buildEnableSlurmdbdScript({ dbPass, clusterSlurmName, usernames });

  await appendLog(taskId, "\n[aura] Auto-enabling Slurm accounting (slurmdbd)…");

  const success: boolean = await new Promise((resolve) => {
    sshExecScript(sshTarget, script, {
      // Same rationale as the main bootstrap call: slurmdbd enable can
      // trigger apt installs + service restarts that easily exceed 60 s.
      timeoutMs: 15 * 60 * 1000,
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(taskId, trimmed);
        }
      },
      onComplete: (ok) => resolve(ok),
    });
  });

  if (success) {
    cfg.vault_slurmdbd_storage_pass = dbPass;
    await prisma.cluster.update({ where: { id: clusterId }, data: { config: cfg as never } });
    await appendLog(taskId, "[aura] Slurm accounting enabled and persisted.");
  } else {
    await appendLog(taskId, "[aura] Slurm accounting auto-enable failed — you can retry via the Accounting tab.");
  }
}
