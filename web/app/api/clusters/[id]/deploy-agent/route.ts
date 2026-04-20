import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function buildInstallScript(cluster: { id: string; name: string }, natsUrl: string): string {
  return `#!/bin/bash
set -euo pipefail

CLUSTER_ID="${cluster.id}"
NATS_URL="${natsUrl}"

echo ""
echo "============================================"
echo "  SlurmUI Agent Installer"
echo "  Cluster: ${cluster.name}"
echo "============================================"
echo ""
echo "[1/8] Gathering system information..."
echo "  Hostname:  $(hostname)"
echo "  OS:        $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '"' || uname -s)"
echo "  Kernel:    $(uname -r)"
echo "  Uptime:    $(uptime -p 2>/dev/null || uptime)"
echo "  User:      $(whoami)"
echo "  CLUSTER_ID: $CLUSTER_ID"
echo "  NATS_URL:   $NATS_URL"
echo ""

echo "[2/8] Detecting architecture..."
MACHINE=$(uname -m)
case "$MACHINE" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  arm64)   ARCH="arm64" ;;
  *)
    echo "  ERROR: Unsupported architecture: $MACHINE"
    exit 1
    ;;
esac
echo "  Architecture: $ARCH ($MACHINE)"
echo "  CPU cores:    $(nproc 2>/dev/null || echo unknown)"
echo "  Memory:       $(free -h 2>/dev/null | awk '/^Mem:/{print $2}' || echo unknown)"
echo ""

echo "[3/8] Checking for existing agent binary..."
AGENT_SRC=""
for candidate in /opt/aura/aura-agent-$ARCH /usr/local/bin/aura-agent; do
  if [ -f "$candidate" ]; then
    AGENT_SRC="$candidate"
    echo "  Found existing binary: $candidate"
    break
  else
    echo "  Not found: $candidate"
  fi
done

if [ -n "$AGENT_SRC" ]; then
  echo "  Copying $AGENT_SRC -> /usr/local/bin/aura-agent"
  cp "$AGENT_SRC" /usr/local/bin/aura-agent
  chmod +x /usr/local/bin/aura-agent
  echo "  Binary installed successfully"
else
  echo "  ERROR: No agent binary found on this host."
  echo "  Expected at /opt/aura/aura-agent-$ARCH or /usr/local/bin/aura-agent"
  echo "  Please deploy the agent binary to the node first."
  exit 1
fi
echo ""

echo "[4/8] Installing system prerequisites..."
echo "  Running: apt-get update"
apt-get update -qq 2>&1 | tail -3
echo "  Running: apt-get install curl openssh-client netcat-openbsd python3 python3-pip"
apt-get install -y -qq curl openssh-client netcat-openbsd python3 python3-pip 2>&1 | grep -E "^(Setting up|already the newest)" | head -10 || true
echo "  System prerequisites ready"
echo ""

echo "[5/8] Checking Ansible installation..."
if command -v ansible-playbook &>/dev/null; then
  echo "  Ansible already installed: $(ansible-playbook --version 2>/dev/null | head -1)"
else
  echo "  Ansible not found, installing ansible-core 2.16..."
  if pip3 install --help 2>/dev/null | grep -q 'break-system-packages'; then
    pip3 install --break-system-packages "ansible-core==2.16.*" 2>&1 | tail -5
  else
    pip3 install "ansible-core==2.16.*" 2>&1 | tail -5
  fi
  echo "  Ansible installed: $(ansible-playbook --version 2>/dev/null | head -1)"
fi
echo ""

echo "[6/8] Installing Ansible collections..."
echo "  Running: ansible-galaxy collection install ansible.posix"
ansible-galaxy collection install ansible.posix 2>&1 | tail -3 || true
echo "  Ansible collections ready"
echo ""

echo "[7/8] Writing agent configuration..."
mkdir -p /etc/aura-agent
cat > /etc/aura-agent/agent.env <<EOF
CLUSTER_ID=$CLUSTER_ID
NATS_URL=$NATS_URL
SLURM_USER=slurm
ANSIBLE_PLAYBOOK_DIR=/opt/aura/ansible
EOF
echo "  Written: /etc/aura-agent/agent.env"
echo "    CLUSTER_ID=$CLUSTER_ID"
echo "    NATS_URL=$NATS_URL"
echo "    SLURM_USER=slurm"
echo "    ANSIBLE_PLAYBOOK_DIR=/opt/aura/ansible"

echo "  Creating systemd unit: /etc/systemd/system/aura-agent.service"
cat > /etc/systemd/system/aura-agent.service <<EOF
[Unit]
Description=Aura HPC Agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/aura-agent/agent.env
ExecStart=/usr/local/bin/aura-agent
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
echo "  Systemd unit created"
echo ""

echo "[8/8] Starting aura-agent service..."
echo "  Running: systemctl daemon-reload"
systemctl daemon-reload
echo "  Running: systemctl enable aura-agent"
systemctl enable aura-agent 2>&1 || true
echo "  Running: systemctl start aura-agent"
systemctl start aura-agent
echo "  Checking service status..."
sleep 1
if systemctl is-active --quiet aura-agent; then
  echo "  aura-agent is RUNNING"
else
  echo "  WARNING: aura-agent may not have started. Checking logs..."
  journalctl -u aura-agent --no-pager -n 10 2>/dev/null || true
fi
echo ""
echo "============================================"
echo "  Agent deployment complete!"
echo "  The agent will now connect to NATS and"
echo "  send its first heartbeat."
echo "============================================"
`;
}

// POST /api/clusters/[id]/deploy-agent — SSH into the controller and install the agent
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
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }
  if (!cluster.sshKey) {
    return NextResponse.json(
      { error: "No SSH key assigned to this cluster." },
      { status: 412 },
    );
  }

  const body = await req.json();
  const sshUser = cluster.sshUser;
  const sshPort = String(cluster.sshPort);
  const controllerHost = cluster.controllerHost;
  const natsUrl = cluster.natsUrl || body.natsUrl || process.env.NATS_ADVERTISE_URL || process.env.NATS_URL || "nats://nats:4222";

  const enc = new TextEncoder();
  let seq = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };

      let tmpDir: string | null = null;

      try {
        tmpDir = mkdtempSync(join(tmpdir(), "aura-deploy-"));
        const keyPath = join(tmpDir, "ssh_key");

        // Write SSH key
        send({ type: "stream", line: `[ssh] Preparing SSH key (${cluster.sshKey!.name})...`, seq: seq++ });
        writeFileSync(keyPath, cluster.sshKey!.privateKey, { mode: 0o600 });
        chmodSync(keyPath, 0o600);
        send({ type: "stream", line: `[ssh] SSH key written to temporary file`, seq: seq++ });

        // Build install script
        send({ type: "stream", line: `[ssh] Building install script for cluster "${cluster.name}"...`, seq: seq++ });
        const script = buildInstallScript(
          { id: cluster.id, name: cluster.name },
          natsUrl,
        );
        send({ type: "stream", line: `[ssh] Install script ready (${script.length} bytes)`, seq: seq++ });
        send({ type: "stream", line: ``, seq: seq++ });

        // SSH connection
        send({ type: "stream", line: `[ssh] Connecting to ${sshUser}@${controllerHost}:${sshPort}...`, seq: seq++ });
        send({ type: "stream", line: `[ssh] Options: StrictHostKeyChecking=no, ConnectTimeout=15s, BatchMode=yes`, seq: seq++ });
        send({ type: "stream", line: ``, seq: seq++ });

        const sshArgs = [
          "-i", keyPath,
          "-p", sshPort,
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "ConnectTimeout=15",
          "-o", "BatchMode=yes",
          "-o", "LogLevel=VERBOSE",
          `${sshUser}@${controllerHost}`,
          "bash -s",
        ];

        const proc = spawn("ssh", sshArgs, {
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Pipe the install script to stdin
        proc.stdin.write(script);
        proc.stdin.end();

        proc.stdout.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().split("\n")) {
            if (line) send({ type: "stream", line, seq: seq++ });
          }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().split("\n")) {
            if (!line) continue;
            // SSH debug/verbose logs — show them as ssh-prefixed info
            if (line.startsWith("debug1:") || line.startsWith("Authenticated")) {
              send({ type: "stream", line: `[ssh] ${line}`, seq: seq++ });
            } else if (line.includes("Warning: Permanently added")) {
              send({ type: "stream", line: `[ssh] ${line}`, seq: seq++ });
            } else {
              send({ type: "stream", line: `[stderr] ${line}`, seq: seq++ });
            }
          }
        });

        proc.on("close", async (code) => {
          try {
            send({ type: "stream", line: ``, seq: seq++ });
            if (code === 0) {
              send({ type: "stream", line: `[ssh] SSH session closed (exit code 0)`, seq: seq++ });
              send({ type: "stream", line: `[aura] Agent deployed successfully. Waiting for heartbeat...`, seq: seq++ });
              send({ type: "deployed", success: true });
              logAudit({
                action: "cluster.deploy",
                entity: "Cluster",
                entityId: cluster.id,
                metadata: { name: cluster.name, controllerHost, sshUser },
              });
            } else {
              send({ type: "stream", line: `[ssh] SSH session closed with exit code ${code}`, seq: seq++ });
              send({
                type: "complete",
                success: false,
                message: `SSH command exited with code ${code}`,
              });
              controller.close();
            }
          } finally {
            if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
          }
        });

        proc.on("error", (err) => {
          send({ type: "stream", line: `[ssh] Failed to start SSH process: ${err.message}`, seq: seq++ });
          send({
            type: "complete",
            success: false,
            message: `Failed to start SSH: ${err.message}`,
          });
          controller.close();
          if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
        });
      } catch (err) {
        send({
          type: "complete",
          success: false,
          message: err instanceof Error ? err.message : "Unknown error",
        });
        controller.close();
        if (tmpDir) {
          try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
