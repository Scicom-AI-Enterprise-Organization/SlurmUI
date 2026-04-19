import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";

interface RouteParams { params: Promise<{ id: string }> }
interface HostEntry { hostname: string; ip: string; user?: string; port?: number }

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

// POST /api/clusters/[id]/nodes/sync-hosts
// Writes /etc/hosts entries (ip  hostname [node-reported hostname]) on every
// node so slurmstepd/srun can resolve peers by whatever name slurmctld uses.
// Also SSH-gathers each node's self-reported `hostname` and includes that.
export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey) {
    return NextResponse.json({ error: "Cluster not reachable" }, { status: 412 });
  }

  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  if (hostsEntries.length === 0) {
    return NextResponse.json({ error: "No nodes registered" }, { status: 400 });
  }

  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: "sync_hosts" },
  });

  const sshTarget = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  // Collect each node's actual hostname (what slurmd registers with slurmctld)
  // by sshing in and running `hostname`. Then build a /etc/hosts block that maps
  // IP → aura_hostname + real_hostname (short + FQDN), and push it to every node.
  const discoverAndSync = hostsEntries.map((h) => {
    const u = h.user || "root";
    const p = h.port || 22;
    return `
echo "[discover] ${h.hostname} (${h.ip}) real hostname..."
REAL_${h.hostname.replace(/[^A-Za-z0-9_]/g, "_")}=$(ssh -n -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 -p ${p} ${u}@${h.ip} 'echo "$(hostname -f 2>/dev/null || hostname) $(hostname -s 2>/dev/null || hostname)"' 2>/dev/null || echo "")
echo "  ${h.hostname} (${h.ip}) => $REAL_${h.hostname.replace(/[^A-Za-z0-9_]/g, "_")}"`;
  }).join("\n");

  const writeBlock = hostsEntries.map((h) => {
    const u = h.user || "root";
    const p = h.port || 22;
    const safeVar = `REAL_${h.hostname.replace(/[^A-Za-z0-9_]/g, "_")}`;
    return `
echo "[write] ${h.hostname} (${h.ip})..."
ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 -p ${p} ${u}@${h.ip} bash -s <<NODE_EOF
set +e
S=""; [ "\\$(id -u)" != "0" ] && S="sudo -n"

# Step 1: report + strip the Ubuntu cloud-init loopback-alias line
# (127.0.1.1 <hostname>) — without this the aura-managed hostname entries
# lose the lookup race and Gloo/NCCL master_addr resolves to 127.0.1.1,
# which remote ranks can't reach → "Connection refused" at init_process_group.
BEFORE_LOOP=\\$(grep -c '^127\\.0\\.1\\.1[[:space:]]' /etc/hosts 2>/dev/null || echo 0)
\\$S sed -i "/^127\\\\.0\\\\.1\\\\.1[[:space:]]/d" /etc/hosts
AFTER_LOOP=\\$(grep -c '^127\\.0\\.1\\.1[[:space:]]' /etc/hosts 2>/dev/null || echo 0)
if [ "\\$BEFORE_LOOP" = "0" ]; then
  echo "  loopback-alias: none present — ok"
else
  echo "  loopback-alias: removed \\$BEFORE_LOOP line(s) (127.0.1.1 \\$(hostname))"
fi

# Step 2: replace the aura-managed block.
\\$S sed -i '/# BEGIN aura-hosts/,/# END aura-hosts/d' /etc/hosts
\\$S bash -c "cat >> /etc/hosts" <<HOSTS_EOF
# BEGIN aura-hosts
${hostsEntries.map((e) => `${e.ip} ${e.hostname} $REAL_${e.hostname.replace(/[^A-Za-z0-9_]/g, "_")}`).join("\n")}
# END aura-hosts
HOSTS_EOF
echo "  wrote \\$(grep -c 'aura-hosts' /etc/hosts) marker lines, \\$(grep -A 100 'BEGIN aura-hosts' /etc/hosts | grep -B 100 'END aura-hosts' | wc -l) total lines"

# Step 3: verify hostname resolves to the aura-managed IP (NOT 127.*).
RESOLVED=\\$(getent hosts \\$(hostname) 2>/dev/null | awk '{print \\$1}' | head -1)
if [ -z "\\$RESOLVED" ]; then
  echo "  FAIL: hostname \\$(hostname) does not resolve at all"
elif echo "\\$RESOLVED" | grep -qE '^127\\.'; then
  echo "  FAIL: hostname \\$(hostname) still resolves to loopback \\$RESOLVED — multi-node rendezvous will break"
else
  echo "  verify: hostname \\$(hostname) → \\$RESOLVED  (ok, not loopback)"
fi
NODE_EOF`;
  }).join("\n");

  // From each node, ping every other peer by both its Aura hostname and IP
  // to verify hostname resolution + L3 reachability. Also probe slurmd TCP.
  const connectivityBlock = hostsEntries.map((src) => {
    const u = src.user || "root";
    const p = src.port || 22;
    const peers = hostsEntries.filter((h) => h.hostname !== src.hostname);
    if (peers.length === 0) return "";
    const checks = peers.map((peer) => `
  echo "  -> ${peer.hostname} (${peer.ip}):"
  # resolve via /etc/hosts + DNS
  RESOLVED=$(getent hosts ${peer.hostname} | awk '{print $1}' | head -1)
  echo "     resolves to: \${RESOLVED:-<none>}"
  # ping by hostname (1 packet, 2s timeout)
  if ping -c 1 -W 2 ${peer.hostname} >/dev/null 2>&1; then
    echo "     ping by name: OK"
  else
    echo "     ping by name: FAIL"
  fi
  # ping by IP
  if ping -c 1 -W 2 ${peer.ip} >/dev/null 2>&1; then
    echo "     ping by ip:   OK"
  else
    echo "     ping by ip:   FAIL"
  fi
  # slurmd port (6818)
  if timeout 3 bash -c "</dev/tcp/${peer.ip}/6818" 2>/dev/null; then
    echo "     tcp 6818:     OK"
  else
    echo "     tcp 6818:     FAIL (firewall or slurmd down)"
  fi`).join("\n");
    return `
echo "[from ${src.hostname}]"
ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 -p ${p} ${u}@${src.ip} bash -s <<'NODE_EOF' 2>&1
set +e
${checks}
NODE_EOF`;
  }).join("\n");

  const script = `#!/bin/bash
set +e

echo "============================================"
echo "  Syncing /etc/hosts across ${hostsEntries.length} node(s)"
echo "============================================"
echo ""

echo "[1/3] Discovering each node's real hostname..."
${discoverAndSync}
echo ""

echo "[2/3] Writing /etc/hosts block on every node..."
${writeBlock}
echo ""

echo "[3/3] Verifying worker-to-worker connectivity..."
${connectivityBlock}
echo ""

echo "[aura] Done. If every row above says OK, multi-node jobs will work."
`;

  (async () => {
    await appendLog(task.id, `[aura] Syncing /etc/hosts across ${hostsEntries.length} node(s)`);
    const handle = sshExecScript(sshTarget, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          await appendLog(task.id, "\n[aura] /etc/hosts synced.");
          await logAudit({ action: "nodes.sync_hosts", entity: "Cluster", entityId: id, metadata: { count: hostsEntries.length } });
        } else {
          await appendLog(task.id, "\n[aura] Sync failed or was cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id });
}
