import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";
import { mergeMetricsConfig, readMetricsConfig, resolveStackHost } from "@/lib/metrics-config";

interface RouteParams {
  params: Promise<{ id: string }>;
}

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

const NODE_EXPORTER_VERSION = "1.8.2";
const NVIDIA_GPU_EXPORTER_VERSION = "1.3.2";
const DCGM_EXPORTER_IMAGE = "nvcr.io/nvidia/k8s/dcgm-exporter:3.3.7-3.5.0-ubuntu22.04";
const PROMTAIL_VERSION = "3.2.1";

interface PromtailOptions {
  enabled: boolean;
  pushUrl: string;   // e.g. http://<stackIp>:3100/loki/api/v1/push
  cluster: string;   // label for log lines
}

/**
 * Build the bash that installs node_exporter (always) plus a GPU exporter
 * onto a single host. The mode is decided server-side per host:
 *   - "dcgm":        run nvcr.io/nvidia/k8s/dcgm-exporter via docker
 *   - "nvidia_smi":  install utkuozdemir/nvidia_gpu_exporter binary as systemd
 *   - "auto":        let the script pick (docker present + GPU + not in
 *                    container -> dcgm, else nvidia_smi)
 *
 * When `promtail.enabled`, also installs Grafana promtail as a systemd
 * service shipping journal + /mnt/shared/*.out (job stdout) to Loki.
 */
function buildInstallScript(mode: "dcgm" | "nvidia_smi" | "auto", promtail: PromtailOptions): string {
  return `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

S=""
[ "$(id -u)" != "0" ] && S="sudo"

ARCH=$(uname -m)
case "$ARCH" in
  x86_64) NEARCH=amd64 ;;
  aarch64) NEARCH=arm64 ;;
  *) echo "[error] Unsupported arch: $ARCH"; exit 1 ;;
esac

############################################################
# node_exporter — host metrics on :9100
#
# Reuse only when the listener is bound to a non-loopback address (so
# Prometheus on another host can actually reach it). A 127.0.0.1 binding
# is treated as broken — we tear it down and reinstall ours bound to
# 0.0.0.0.
############################################################
NE_BIND=$(ss -ltn 2>/dev/null | awk '$4 ~ /:9100$/ {print $4}' | head -1)
NE_REACHABLE=0
case "$NE_BIND" in
  ""|127.0.0.1:*|::1:*|"[::1]":*) ;;
  *) NE_REACHABLE=1 ;;
esac
NE_INSTALL=1
if [ "$NE_REACHABLE" = "1" ] && curl -sf --max-time 2 http://127.0.0.1:9100/metrics 2>/dev/null | head -5 | grep -q '^node_'; then
  echo "[node_exporter] :9100 already exposed externally (bind=$NE_BIND) — reusing"
  NE_INSTALL=0
elif [ -n "$NE_BIND" ]; then
  echo "[node_exporter] :9100 bound to $NE_BIND (loopback only) — tearing down to rebind on 0.0.0.0"
  $S systemctl stop node_exporter 2>/dev/null || true
  # Kill any other process holding :9100
  PIDS=$(ss -ltnp 2>/dev/null | awk '$4 ~ /:9100$/ {print $7}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  for pid in $PIDS; do $S kill "$pid" 2>/dev/null || true; done
  sleep 1
fi

if [ "$NE_INSTALL" = "1" ]; then
  echo "[node_exporter] installing v${NODE_EXPORTER_VERSION} ($NEARCH)..."
  TMP=$(mktemp -d)
  cd "$TMP"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://github.com/prometheus/node_exporter/releases/download/v${NODE_EXPORTER_VERSION}/node_exporter-${NODE_EXPORTER_VERSION}.linux-$NEARCH.tar.gz" -o ne.tgz
  else
    wget -q "https://github.com/prometheus/node_exporter/releases/download/v${NODE_EXPORTER_VERSION}/node_exporter-${NODE_EXPORTER_VERSION}.linux-$NEARCH.tar.gz" -O ne.tgz
  fi
  tar xzf ne.tgz
  $S install -m 0755 node_exporter-${NODE_EXPORTER_VERSION}.linux-$NEARCH/node_exporter /usr/local/bin/node_exporter
  cd / && rm -rf "$TMP"

  $S id node_exporter >/dev/null 2>&1 || $S useradd --no-create-home --shell /usr/sbin/nologin node_exporter

  $S tee /etc/systemd/system/node_exporter.service >/dev/null <<'UNIT'
[Unit]
Description=Prometheus Node Exporter
After=network.target

[Service]
User=node_exporter
Group=node_exporter
Type=simple
ExecStart=/usr/local/bin/node_exporter
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  $S systemctl daemon-reload
  $S systemctl enable --now node_exporter
fi
sleep 1
NE_BIND2=$(ss -ltn 2>/dev/null | awk '$4 ~ /:9100$/ {print $4}' | head -1)
if [ -n "$NE_BIND2" ]; then
  echo "[node_exporter] listening on $NE_BIND2"
else
  echo "[node_exporter] WARNING not listening on :9100"
fi

############################################################
# GPU exporter — :9400
############################################################
MODE="${mode}"

# Same loopback-aware reuse logic as node_exporter. We only reuse when
# the listener is reachable from outside the host; loopback-only bindings
# (e.g. docker run -p 127.0.0.1:9400:9400) are torn down and replaced.
GPU_BIND=$(ss -ltn 2>/dev/null | awk '$4 ~ /:9400$/ {print $4}' | head -1)
GPU_REACHABLE=0
case "$GPU_BIND" in
  ""|127.0.0.1:*|::1:*|"[::1]":*) ;;
  *) GPU_REACHABLE=1 ;;
esac

EXISTING_GPU=""
if [ "$GPU_REACHABLE" = "1" ]; then
  PROBE=$(curl -sf --max-time 2 http://127.0.0.1:9400/metrics 2>/dev/null | head -200 || true)
  if echo "$PROBE" | grep -q '^DCGM_FI_'; then
    echo "[gpu] :9400 exposed externally (bind=$GPU_BIND), DCGM-style metrics — reusing"
    EXISTING_GPU=dcgm
  elif echo "$PROBE" | grep -qE '^(nvidia_smi_|nvidia_gpu_)'; then
    echo "[gpu] :9400 exposed externally (bind=$GPU_BIND), nvidia-smi metrics — reusing"
    EXISTING_GPU=nvidia_smi
  fi
elif [ -n "$GPU_BIND" ]; then
  echo "[gpu] :9400 bound to $GPU_BIND (loopback only) — tearing down to rebind on 0.0.0.0"
  if command -v docker >/dev/null 2>&1; then
    # Match ANY container with a :9400 port mapping, regardless of bind
    # address. \`--filter publish=9400\` was missing loopback-bound
    # containers like \`127.0.0.1:9400->9400/tcp\` on some docker versions,
    # so we parse the Ports column ourselves.
    for c in $(docker ps -a --format '{{.Names}}|{{.Ports}}' 2>/dev/null | awk -F'|' '$2 ~ /:9400(->|\\/)/{print $1}'); do
      echo "[gpu] removing container $c"
      $S docker rm -f "$c" >/dev/null 2>&1 || true
    done
  fi
  $S systemctl stop nvidia_gpu_exporter 2>/dev/null || true
  # Kill anything still holding the port (covers raw binaries, lingering
  # docker-proxy, etc.). fuser is the most universal; falls back to ss + kill.
  if command -v fuser >/dev/null 2>&1; then
    $S fuser -k -n tcp 9400 2>/dev/null || true
  else
    PIDS=$(ss -ltnp 2>/dev/null | awk '$4 ~ /:9400$/ {print $7}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
    for pid in $PIDS; do $S kill -9 "$pid" 2>/dev/null || true; done
  fi
  # Wait for the port to actually release — docker-proxy can take a beat
  # to clean up iptables rules after the container is removed.
  for i in 1 2 3 4 5 6 7 8; do
    ss -ltn 2>/dev/null | awk '$4 ~ /:9400$/' | grep -q . || break
    sleep 1
  done
  STILL=$(ss -ltn 2>/dev/null | awk '$4 ~ /:9400$/ {print $4}' | head -1)
  if [ -n "$STILL" ]; then
    echo "[gpu] WARNING port still held by $STILL after teardown — install will likely fail. Investigate via 'fuser -v -n tcp 9400' and 'docker ps -a | grep 9400'."
  else
    echo "[gpu] :9400 released"
  fi
fi

if [ -n "$EXISTING_GPU" ]; then
  MODE="$EXISTING_GPU"
else
  if [ "$MODE" = "auto" ]; then
    VIRT=$(systemd-detect-virt 2>/dev/null || echo none)
    if echo "$VIRT" | grep -qE 'lxc|docker|podman|container'; then
      MODE=nvidia_smi
    elif command -v docker >/dev/null 2>&1 && command -v nvidia-smi >/dev/null 2>&1; then
      MODE=dcgm
    else
      MODE=nvidia_smi
    fi
  fi
  echo "[gpu] selected exporter mode: $MODE"

  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "[gpu] nvidia-smi not found — skipping GPU exporter (host metrics only)"
  elif [ "$MODE" = "dcgm" ]; then
    if ! command -v docker >/dev/null 2>&1; then
      echo "[gpu] docker not found — falling back to nvidia_smi exporter"
      MODE=nvidia_smi
    fi
  fi
fi

if [ -n "$EXISTING_GPU" ]; then
  : # nothing to install — already externally reachable
elif [ "$MODE" = "dcgm" ] && command -v nvidia-smi >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
  echo "[dcgm-exporter] starting container bound on 0.0.0.0..."
  $S docker rm -f aura-dcgm-exporter >/dev/null 2>&1 || true
  $S docker run -d --restart unless-stopped --gpus all \\
    --name aura-dcgm-exporter \\
    -p 0.0.0.0:9400:9400 \\
    ${DCGM_EXPORTER_IMAGE} 2>&1 | tail -5
elif [ "$MODE" = "nvidia_smi" ] && command -v nvidia-smi >/dev/null 2>&1; then
  if systemctl is-active --quiet nvidia_gpu_exporter 2>/dev/null && [ "$GPU_REACHABLE" = "1" ]; then
    echo "[nvidia_gpu_exporter] already running"
  else
    echo "[nvidia_gpu_exporter] installing v${NVIDIA_GPU_EXPORTER_VERSION} ($NEARCH)..."
    TMP=$(mktemp -d)
    cd "$TMP"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "https://github.com/utkuozdemir/nvidia_gpu_exporter/releases/download/v${NVIDIA_GPU_EXPORTER_VERSION}/nvidia_gpu_exporter_${NVIDIA_GPU_EXPORTER_VERSION}_linux_$NEARCH.tar.gz" -o ge.tgz
    else
      wget -q "https://github.com/utkuozdemir/nvidia_gpu_exporter/releases/download/v${NVIDIA_GPU_EXPORTER_VERSION}/nvidia_gpu_exporter_${NVIDIA_GPU_EXPORTER_VERSION}_linux_$NEARCH.tar.gz" -O ge.tgz
    fi
    tar xzf ge.tgz
    $S install -m 0755 nvidia_gpu_exporter /usr/local/bin/nvidia_gpu_exporter
    cd / && rm -rf "$TMP"

    $S tee /etc/systemd/system/nvidia_gpu_exporter.service >/dev/null <<'UNIT'
[Unit]
Description=NVIDIA GPU Exporter (nvidia-smi)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/nvidia_gpu_exporter --web.listen-address=:9400
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

    $S systemctl daemon-reload
    $S systemctl enable --now nvidia_gpu_exporter
  fi
fi
sleep 2
GPU_BIND2=$(ss -ltn 2>/dev/null | awk '$4 ~ /:9400$/ {print $4}' | head -1)
if [ -n "$GPU_BIND2" ]; then
  case "$GPU_BIND2" in
    127.0.0.1:*|::1:*|"[::1]":*) echo "[gpu] WARNING still loopback-only on $GPU_BIND2" ;;
    *) echo "[gpu] listening on $GPU_BIND2 ($MODE)" ;;
  esac
else
  echo "[gpu] not listening on :9400 ($MODE) — may be expected if no GPU"
fi

echo "INSTALLED_MODE=$MODE"

${promtail.enabled ? `############################################################
# promtail — ships journal + job stdout to the cluster's Loki
############################################################
HOST=$(hostname)
echo "[promtail] installing v${PROMTAIL_VERSION} ($NEARCH)..."
$S id promtail >/dev/null 2>&1 || $S useradd --no-create-home --shell /usr/sbin/nologin promtail
# Promtail needs to read systemd journal — adm group covers that on Debian/Ubuntu;
# systemd-journal on RHEL.
$S usermod -aG adm promtail 2>/dev/null || true
$S usermod -aG systemd-journal promtail 2>/dev/null || true

if [ ! -x /usr/local/bin/promtail ] || ! /usr/local/bin/promtail --version 2>&1 | grep -q "${PROMTAIL_VERSION}"; then
  TMP=$(mktemp -d)
  cd "$TMP"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://github.com/grafana/loki/releases/download/v${PROMTAIL_VERSION}/promtail-linux-$NEARCH.zip" -o promtail.zip
  else
    wget -q "https://github.com/grafana/loki/releases/download/v${PROMTAIL_VERSION}/promtail-linux-$NEARCH.zip" -O promtail.zip
  fi
  if command -v unzip >/dev/null 2>&1; then
    unzip -o promtail.zip
  elif command -v bsdtar >/dev/null 2>&1; then
    bsdtar xf promtail.zip
  else
    $S apt-get install -y -qq unzip 2>/dev/null || $S dnf install -y unzip 2>/dev/null || true
    unzip -o promtail.zip
  fi
  $S install -m 0755 promtail-linux-$NEARCH /usr/local/bin/promtail
  cd / && rm -rf "$TMP"
else
  echo "[promtail] binary already up to date"
fi

$S mkdir -p /etc/promtail /var/lib/promtail
$S chown promtail:promtail /var/lib/promtail

# Use cat <<EOF (NOT quoted) so \$HOST gets expanded to the actual hostname.
$S tee /etc/promtail/promtail.yaml >/dev/null <<EOF
server:
  http_listen_port: 9080
  grpc_listen_port: 0
positions:
  filename: /var/lib/promtail/positions.yaml
clients:
  - url: ${promtail.pushUrl}
scrape_configs:
  - job_name: systemd-journal
    journal:
      path: /var/log/journal
      max_age: 24h
      labels:
        cluster: ${promtail.cluster}
        instance: $HOST
        job: systemd-journal
    relabel_configs:
      - source_labels: ['__journal__systemd_unit']
        target_label: 'unit'
      - source_labels: ['__journal_priority_keyword']
        target_label: 'level'
  - job_name: slurm-job-output
    static_configs:
      - targets: [localhost]
        labels:
          cluster: ${promtail.cluster}
          instance: $HOST
          job: slurm-output
          __path__: /mnt/shared/*.out
    pipeline_stages:
      - match:
          # The job output filename pattern from job-template-helpers
          # ("<jobname>-<jobid>.out") — pull jobid out as a label.
          selector: '{job="slurm-output"}'
          stages:
            - regex:
                source: filename
                expression: '.*-(?P<jobid>\\d+)\\.out$'
            - labels:
                jobid:
EOF
$S chown promtail:promtail /etc/promtail/promtail.yaml

$S tee /etc/systemd/system/promtail.service >/dev/null <<UNIT
[Unit]
Description=Grafana Promtail (log shipper to Loki)
After=network.target

[Service]
User=promtail
Group=promtail
Type=simple
ExecStart=/usr/local/bin/promtail -config.file=/etc/promtail/promtail.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

$S systemctl daemon-reload
$S systemctl enable promtail
$S systemctl restart promtail
sleep 1
ss -ltn 2>/dev/null | grep -q ':9080 ' && echo "[promtail] running, shipping to ${promtail.pushUrl}" || echo "[promtail] WARNING not listening on :9080 — check journalctl -u promtail"
` : `# Loki disabled — uninstall promtail if it exists.
if systemctl list-unit-files 2>/dev/null | grep -q '^promtail\\.service'; then
  echo "[promtail] disabling existing promtail (lokiEnabled=false)"
  $S systemctl disable --now promtail 2>/dev/null || true
  $S rm -f /etc/systemd/system/promtail.service /usr/local/bin/promtail
  $S systemctl daemon-reload 2>/dev/null || true
fi
`}

exit 0
`;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const targetHostnames: string[] | undefined = Array.isArray(body.hostnames) ? body.hostnames : undefined;
  const overrideMode: "dcgm" | "nvidia_smi" | "auto" | undefined = body.mode;

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const metrics = readMetricsConfig(config);
  const mode = overrideMode ?? metrics.exporterMode;

  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const targets: HostEntry[] = (targetHostnames && targetHostnames.length > 0)
    ? hostsEntries.filter((h) => targetHostnames.includes(h.hostname))
    : hostsEntries;
  if (targets.length === 0) {
    return NextResponse.json({ error: "No matching nodes" }, { status: 400 });
  }

  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: "metrics_install" },
  });

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
    jumpHost: cluster.sshJumpHost,
    jumpUser: cluster.sshJumpUser,
    jumpPort: cluster.sshJumpPort,
    proxyCommand: cluster.sshProxyCommand,
    jumpProxyCommand: cluster.sshJumpProxyCommand,
  };

  // The install body runs on each worker via SSH-from-controller; we reuse
  // the same helper script and ssh into each target sequentially so logs are
  // grouped per-host. promtail (when enabled) needs the stack host's IP
  // baked in so each node knows where to push logs.
  const stack = resolveStackHost(cluster.controllerHost, config, metrics);
  const stackIpForPush = stack.isController ? cluster.controllerHost : stack.ip;
  const inner = buildInstallScript(mode, {
    enabled: !!metrics.lokiEnabled,
    pushUrl: `http://${stackIpForPush}:${metrics.lokiPort}/loki/api/v1/push`,
    cluster: cluster.name,
  });
  const workerBlock = targets.map((h) => {
    const u = h.user || "root";
    const p = h.port || 22;
    return `
echo "============================================"
echo "  [${h.hostname}] Installing exporters..."
echo "============================================"
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p ${p} ${u}@${h.ip} bash -s <<'NODE_EOF'
${inner}
NODE_EOF
RC=$?
echo "[${h.hostname}] exit=$RC"
echo ""`;
  }).join("\n");

  const script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

echo "============================================"
echo "  Metrics install"
echo "  Mode: ${mode}"
echo "  Targets: ${targets.length}"
echo "============================================"
echo ""
${workerBlock}
echo ""
echo "[aura] All hosts processed."
exit 0
`;

  (async () => {
    await appendLog(task.id, `[aura] Installing metrics exporters on ${targets.length} host(s)`);
    const installedMode: Record<string, "dcgm" | "nvidia_smi"> = {};
    let currentHost: string | null = null;
    const handle = sshExecScript(target, script, {
      timeoutMs: 30 * 60 * 1000,
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (!trimmed) return;
        // Track per-host context so the INSTALLED_MODE marker lines can be
        // attributed correctly when nodes log out of order in stream chunks.
        const hostMatch = trimmed.match(/^\[([^\]]+)\] Installing exporters/);
        if (hostMatch) currentHost = hostMatch[1];
        const m = trimmed.match(/^INSTALLED_MODE=(dcgm|nvidia_smi)$/);
        if (m && currentHost) {
          installedMode[currentHost] = m[1] as "dcgm" | "nvidia_smi";
        }
        if (!trimmed.match(/^[a-z]+@[^:]+:[~/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        if (success && Object.keys(installedMode).length > 0) {
          try {
            const fresh = await prisma.cluster.findUnique({ where: { id } });
            if (fresh) {
              const now = new Date().toISOString();
              const nodesPatch: Record<string, { exporter: "dcgm" | "nvidia_smi"; installedAt: string; scrape: true }> = {};
              for (const [hostname, exp] of Object.entries(installedMode)) {
                nodesPatch[hostname] = { exporter: exp, installedAt: now, scrape: true };
              }
              const next = mergeMetricsConfig(fresh.config, {
                enabled: true,
                nodes: nodesPatch,
              });
              await prisma.cluster.update({ where: { id }, data: { config: next as never } });
            }
          } catch {}
          await logAudit({
            action: "metrics.install",
            entity: "Cluster",
            entityId: id,
            metadata: { hosts: targets.map((t) => t.hostname), mode },
          });
          await appendLog(task.id, "\n[aura] Metrics exporters installed successfully.");
        } else if (!success) {
          await appendLog(task.id, "\n[aura] Metrics exporter install failed or was cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id, targets: targets.map((t) => t.hostname) });
}
