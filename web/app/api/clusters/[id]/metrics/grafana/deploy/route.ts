import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";
import {
  mergeMetricsConfig,
  readMetricsConfig,
  resolveScrapeTargets,
  resolveStackHost,
} from "@/lib/metrics-config";

interface RouteParams {
  params: Promise<{ id: string }>;
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

const PROMETHEUS_VERSION = "2.55.1";
const GRAFANA_VERSION = "11.3.0";
const DEFAULT_DATA_PATH = "/var/lib/aura-metrics";

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
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const metrics = readMetricsConfig(config);
  const scrape = resolveScrapeTargets(config, metrics);
  if (scrape.length === 0) {
    return NextResponse.json(
      { error: "No nodes have exporters installed yet — install on at least one node before deploying the stack." },
      { status: 400 },
    );
  }
  const stackHost = resolveStackHost(cluster.controllerHost, config, metrics);

  // Rotate password every deploy. The admin sees it once via the UI; we
  // also persist it so re-renders don't lose access.
  const grafanaPassword = randomBytes(18).toString("base64url");

  const dataPath = ((metrics.stackDataPath ?? "").trim() || DEFAULT_DATA_PATH).replace(/\/+$/, "");
  const promDataDir = `${dataPath}/prometheus`;
  const grafDataDir = `${dataPath}/grafana`;

  const promYml = [
    "global:",
    "  scrape_interval: 15s",
    "  scrape_timeout: 10s",
    "scrape_configs:",
    "  - job_name: node",
    "    static_configs:",
    ...scrape.map((s) =>
      `      - targets: ['${s.ip}:9100']\n        labels: { instance: '${s.hostname}' }`,
    ),
    "  - job_name: gpu",
    "    static_configs:",
    ...scrape.map((s) =>
      `      - targets: ['${s.ip}:9400']\n        labels: { instance: '${s.hostname}' }`,
    ),
  ].join("\n");

  // Resolve aura's external origin from the deploy request so Grafana's
  // root_url generates absolute URLs that reach our reverse-proxy. We take
  // the first available of: X-Forwarded-Proto/Host (when behind another
  // proxy), then the request's host header. Falls back to localhost so a
  // dev-mode deploy still produces a valid (if local-only) URL.
  const proto = (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim();
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost").split(",")[0].trim();
  // Mount lives at /grafana-proxy/<id>/ — outside /api/ so it doesn't
  // collide with Grafana's own /api/* routes (any sub-path starting with
  // /api/ makes Grafana 404 because its router treats it as an API call).
  const rootUrl = `${proto}://${host}/grafana-proxy/${id}/`;

  // serve_from_sub_path=true: Grafana embeds the prefix in every asset URL
  // and strips it from incoming request URLs. Our proxy forwards the full
  // prefixed path verbatim.
  const grafanaIni = `[server]
http_port = ${metrics.grafanaPort}
domain = ${host.replace(/:\d+$/, "")}
root_url = ${rootUrl}
serve_from_sub_path = true

[paths]
data = ${grafDataDir}
logs = ${grafDataDir}/log
plugins = ${grafDataDir}/plugins
provisioning = /etc/grafana/provisioning

[security]
admin_user = admin
admin_password = ${grafanaPassword}
allow_embedding = false

[users]
allow_sign_up = false

[auth.anonymous]
enabled = false

[live]
# Grafana Live needs WebSockets, which our HTTP-only reverse-proxy can't
# tunnel. Disable it so the dashboards stop hammering /api/live/ws and
# spamming console errors. Dashboards still refresh on their own interval.
max_connections = 0
`;

  // Provision a Prometheus datasource pointing at the local prometheus
  // (same host as grafana). Grafana picks this up on startup.
  const datasourcesYaml = `apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://localhost:${metrics.prometheusPort}
    isDefault: true
    editable: true
`;

  // File-based dashboard provider. Grafana imports any *.json under
  // options.path on startup and re-checks every 30s.
  const dashboardsYaml = `apiVersion: 1
providers:
  - name: aura-gpu
    folder: GPU Metrics
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /etc/grafana/provisioning/dashboards/aura-gpu
`;

  // base64-encode all configs so heredoc quoting / shell expansion never
  // mangles colons, quotes, or backticks. The remote side decodes them
  // verbatim.
  const promB64 = Buffer.from(promYml).toString("base64");
  const grafB64 = Buffer.from(grafanaIni).toString("base64");
  const dsB64 = Buffer.from(datasourcesYaml).toString("base64");
  const dbB64 = Buffer.from(dashboardsYaml).toString("base64");

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

  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: "metrics_grafana_deploy" },
  });

  // Inner script — runs on whichever host hosts the stack. Uses upstream
  // tarball releases (no docker, no apt repo) so this works on any glibc
  // Linux without external dependencies.
  const inner = `
S=""
[ "$(id -u)" != "0" ] && S="sudo"

ARCH=$(uname -m)
case "$ARCH" in
  x86_64) NEARCH=amd64 ;;
  aarch64) NEARCH=arm64 ;;
  *) echo "[error] Unsupported arch: $ARCH"; exit 1 ;;
esac

############################################################
# Prometheus binary + systemd unit
############################################################
echo "[prometheus] installing v${PROMETHEUS_VERSION} ($NEARCH)..."
$S id prometheus >/dev/null 2>&1 || $S useradd --no-create-home --shell /usr/sbin/nologin prometheus

if [ ! -x /usr/local/bin/prometheus ] || ! /usr/local/bin/prometheus --version 2>&1 | grep -q "${PROMETHEUS_VERSION}"; then
  TMP=$(mktemp -d)
  cd "$TMP"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-$NEARCH.tar.gz" -o p.tgz
  else
    wget -q "https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-$NEARCH.tar.gz" -O p.tgz
  fi
  tar xzf p.tgz
  $S install -m 0755 prometheus-${PROMETHEUS_VERSION}.linux-$NEARCH/prometheus /usr/local/bin/prometheus
  $S install -m 0755 prometheus-${PROMETHEUS_VERSION}.linux-$NEARCH/promtool /usr/local/bin/promtool
  cd / && rm -rf "$TMP"
else
  echo "[prometheus] binary already up to date"
fi

$S mkdir -p /etc/prometheus ${promDataDir}
echo "${promB64}" | base64 -d | $S tee /etc/prometheus/prometheus.yml >/dev/null
$S chown -R prometheus:prometheus ${promDataDir}
$S chown prometheus:prometheus /etc/prometheus/prometheus.yml

$S tee /etc/systemd/system/prometheus.service >/dev/null <<UNIT
[Unit]
Description=Prometheus
After=network.target

[Service]
User=prometheus
Group=prometheus
Type=simple
ExecStart=/usr/local/bin/prometheus \\
  --config.file=/etc/prometheus/prometheus.yml \\
  --storage.tsdb.path=${promDataDir} \\
  --storage.tsdb.retention.time=${metrics.retention} \\
  --web.enable-lifecycle \\
  --web.listen-address=:${metrics.prometheusPort}
ExecReload=/bin/kill -HUP \\$MAINPID
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

$S systemctl daemon-reload
$S systemctl enable prometheus
$S systemctl restart prometheus

############################################################
# Grafana tarball + systemd unit
############################################################
echo "[grafana] installing v${GRAFANA_VERSION} ($NEARCH)..."
$S id grafana >/dev/null 2>&1 || $S useradd --no-create-home --shell /usr/sbin/nologin grafana

GRAFANA_HOME=/opt/grafana-${GRAFANA_VERSION}
if [ ! -x "$GRAFANA_HOME/bin/grafana" ] && [ ! -x "$GRAFANA_HOME/bin/grafana-server" ]; then
  TMP=$(mktemp -d)
  cd "$TMP"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://dl.grafana.com/oss/release/grafana-${GRAFANA_VERSION}.linux-$NEARCH.tar.gz" -o g.tgz
  else
    wget -q "https://dl.grafana.com/oss/release/grafana-${GRAFANA_VERSION}.linux-$NEARCH.tar.gz" -O g.tgz
  fi
  tar xzf g.tgz
  $S rm -rf "$GRAFANA_HOME"
  $S mv grafana-v${GRAFANA_VERSION} "$GRAFANA_HOME"
  cd / && rm -rf "$TMP"
else
  echo "[grafana] binary already present"
fi
$S ln -sfn "$GRAFANA_HOME" /opt/grafana

# Pick whichever entry binary the tarball ships — recent releases
# (>= 11) use \`grafana\`, older ones \`grafana-server\`.
GRAFANA_BIN=/opt/grafana/bin/grafana
[ -x /opt/grafana/bin/grafana ] || GRAFANA_BIN=/opt/grafana/bin/grafana-server
GRAFANA_ARGS=""
if [ "$GRAFANA_BIN" = "/opt/grafana/bin/grafana" ]; then GRAFANA_ARGS="server"; fi

$S mkdir -p /etc/grafana \\
  /etc/grafana/provisioning \\
  /etc/grafana/provisioning/datasources \\
  /etc/grafana/provisioning/dashboards \\
  /etc/grafana/provisioning/dashboards/aura-gpu \\
  ${grafDataDir} ${grafDataDir}/log ${grafDataDir}/plugins
echo "${grafB64}" | base64 -d | $S tee /etc/grafana/grafana.ini >/dev/null
echo "${dsB64}"   | base64 -d | $S tee /etc/grafana/provisioning/datasources/aura.yaml >/dev/null
echo "${dbB64}"   | base64 -d | $S tee /etc/grafana/provisioning/dashboards/aura.yaml >/dev/null

# Pull the upstream gpu-metrics-exporter dashboards. Combined works for
# both DCGM and nvidia_smi exporters; the others target one mode each.
# Re-fetched every deploy so users get upstream updates automatically.
DASH_BASE=https://raw.githubusercontent.com/Scicom-AI-Enterprise-Organization/gpu-metrics-exporter/main/dashboards
for d in gpu-metrics-combined gpu-metrics-dcgm gpu-metrics-nvidia-smi; do
  TARGET="/etc/grafana/provisioning/dashboards/aura-gpu/$d.json"
  if command -v curl >/dev/null 2>&1; then
    if $S curl -fsSL "$DASH_BASE/$d.json" -o "$TARGET"; then
      echo "[grafana] dashboard $d ok"
    else
      echo "[grafana] dashboard $d FAILED"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if $S wget -q "$DASH_BASE/$d.json" -O "$TARGET"; then
      echo "[grafana] dashboard $d ok"
    else
      echo "[grafana] dashboard $d FAILED"
    fi
  fi
done

# Upstream dashboards reference \${DS_PROMETHEUS} / \${DS_LOKI} datasource
# template variables (resolved only by Grafana's interactive import wizard,
# not file provisioning) and the dcgm dashboard hardcodes \`"uid": "mimir"\`
# in every panel. File-based provisioning needs literal datasource uids
# that exist, so substitute everything to our provisioned "prometheus" uid.
# The Loki-backed XID error panel still won't render (LogQL queries fail
# against Prometheus) but the rest of the dashboard works.
$S find /etc/grafana/provisioning/dashboards/aura-gpu -name "*.json" -type f -print0 | while IFS= read -r -d '' f; do
  $S sed -i \\
    -e 's/\${DS_PROMETHEUS}/prometheus/g' \\
    -e 's/\${DS_LOKI}/prometheus/g' \\
    -e 's/"uid": *"mimir"/"uid": "prometheus"/g' \\
    -e 's/"datasource": *"mimir"/"datasource": "prometheus"/g' \\
    "$f"
done

$S chown -R grafana:grafana ${grafDataDir} /etc/grafana

$S tee /etc/systemd/system/grafana.service >/dev/null <<UNIT
[Unit]
Description=Grafana
After=network.target prometheus.service

[Service]
User=grafana
Group=grafana
Type=simple
WorkingDirectory=/opt/grafana
ExecStart=$GRAFANA_BIN $GRAFANA_ARGS --homepath=/opt/grafana --config=/etc/grafana/grafana.ini
Restart=on-failure
RestartSec=5
LimitNOFILE=10000

[Install]
WantedBy=multi-user.target
UNIT

$S systemctl daemon-reload
$S systemctl enable grafana

# admin_password in grafana.ini is only honoured when Grafana initialises
# the SQLite DB for the first time. On every subsequent deploy we rotate
# the password in our config DB, but Grafana's own DB still has the old
# one — so our injected Basic auth fails. Force-reset via the CLI when
# the DB already exists; otherwise let admin_password handle initial create.

# Pick the CLI binary. Grafana 10+ uses \`grafana cli ...\`; older versions
# ship a separate \`grafana-cli\` binary in the same dir.
if [ -x /opt/grafana/bin/grafana ]; then
  GRAFANA_CLI_CMD="/opt/grafana/bin/grafana cli"
elif [ -x /opt/grafana/bin/grafana-cli ]; then
  GRAFANA_CLI_CMD="/opt/grafana/bin/grafana-cli"
else
  GRAFANA_CLI_CMD=""
fi

# Reset admin password via CLI when the SQLite DB already exists (re-deploy
# case). admin_password in grafana.ini is honoured ONLY when the DB is
# being created — re-deploys would otherwise leave the original password
# in place. Running as root is fine; we chown the data dir back to grafana
# afterwards in case sqlite left journal/temp files owned by root.
PWD_NEW=$(cat <<'PWDEOF'
${grafanaPassword}
PWDEOF
)

echo "[grafana] cli=$GRAFANA_CLI_CMD"
echo "[grafana] grafDataDir=${grafDataDir}"
if [ -f ${grafDataDir}/grafana.db ]; then
  echo "[grafana] db EXISTS — will reset admin password"
else
  echo "[grafana] db DOES NOT exist — admin_password from grafana.ini will be used on first start"
fi

if [ -f ${grafDataDir}/grafana.db ] && [ -n "$GRAFANA_CLI_CMD" ]; then
  $S systemctl stop grafana 2>/dev/null || true
  sleep 1
  $S $GRAFANA_CLI_CMD --homepath=/opt/grafana --config=/etc/grafana/grafana.ini admin reset-admin-password "$PWD_NEW" 2>&1 | tail -20
  RESET_RC=\${PIPESTATUS[0]}
  echo "[grafana] admin password reset rc=$RESET_RC"
  $S chown -R grafana:grafana ${grafDataDir} 2>/dev/null || true
elif [ -f ${grafDataDir}/grafana.db ]; then
  echo "[grafana] WARNING db exists but no CLI binary found — admin password NOT rotated; teardown the stack and re-deploy to reset"
fi
$S systemctl restart grafana

echo ""
echo "[stack] Probing endpoints..."
for i in 1 2 3 4 5; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${metrics.prometheusPort}/-/ready 2>/dev/null || echo "000")
  if [ "$CODE" = "200" ]; then echo "[prometheus] ready (HTTP $CODE)"; break; fi
  echo "[prometheus] not ready ($CODE) — retry $i/5"
  sleep 2
done
for i in 1 2 3 4 5 6 7 8 9 10; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${metrics.grafanaPort}/api/health 2>/dev/null || echo "000")
  if [ "$CODE" = "200" ]; then echo "[grafana] ready (HTTP $CODE)"; break; fi
  echo "[grafana] not ready ($CODE) — retry $i/10"
  sleep 2
done

echo "[stack] Deploy complete."
`;

  // When the stack lives on a worker, hop from controller via ssh and run
  // the inner script there. The single-quoted heredoc preserves all the
  // base64 / template literals verbatim.
  const u = stackHost.user || "root";
  const p = stackHost.port || 22;
  const remoteWrap = stackHost.isController
    ? inner
    : `
echo "[stack] Hopping to ${stackHost.hostname} (${stackHost.ip}) via SSH..."
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p ${p} ${u}@${stackHost.ip} bash -s <<'STACK_EOF'
set +e
${inner}
STACK_EOF
`;

  const script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

echo "============================================"
echo "  Stack deploy"
echo "  Host: ${stackHost.hostname}${stackHost.isController ? " (controller)" : ""}"
echo "  Data: ${dataPath}"
echo "  Retention: ${metrics.retention}"
echo "  Scrape targets: ${scrape.length}"
echo "============================================"
${remoteWrap}
exit 0
`;

  (async () => {
    await appendLog(task.id, `[aura] Deploying Prometheus + Grafana to ${stackHost.hostname}`);
    const handle = sshExecScript(target, script, {
      timeoutMs: 20 * 60 * 1000,
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          try {
            const fresh = await prisma.cluster.findUnique({ where: { id } });
            if (fresh) {
              const next = mergeMetricsConfig(fresh.config, {
                enabled: true,
                grafanaAdminPassword: grafanaPassword,
                grafanaDeployedAt: new Date().toISOString(),
              });
              await prisma.cluster.update({
                where: { id },
                data: { config: next as never },
              });
            }
          } catch {}
          await logAudit({
            action: "metrics.grafana.deploy",
            entity: "Cluster",
            entityId: id,
            metadata: { stackHost: stackHost.hostname, dataPath, scrapeTargets: scrape.length },
          });
          await appendLog(task.id, "\n[aura] Stack deployed. Admin password rotated.");
        } else {
          await appendLog(task.id, "\n[aura] Deploy failed or was cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id, stackHost: stackHost.hostname });
}
