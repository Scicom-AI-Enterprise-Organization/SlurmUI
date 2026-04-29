import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";

// vLLM dashboards (classic / v1 / v2) live in web/dashboards/ and are
// shipped as part of the Next.js build. Read once on module load — the
// route is a long-lived server component and these don't change without
// a redeploy. Datasource uid substitution happens later in the install
// script via sed (same path as the upstream GPU dashboards).
function tryReadDashboard(name: string): string | null {
  // process.cwd() is the web/ directory in dev and prod (next start runs
  // from there). Fall back to ../web/dashboards in case of unusual layouts.
  for (const base of [process.cwd(), join(process.cwd(), "..")]) {
    try {
      return readFileSync(join(base, "dashboards", name), "utf8");
    } catch {}
  }
  return null;
}
const VLLM_DASHBOARDS = {
  "vllm-grafana-classic.json": tryReadDashboard("vllm-grafana-classic.json"),
  "vllm-grafana-v1.json": tryReadDashboard("vllm-grafana-v1.json"),
  "vllm-grafana-v2.json": tryReadDashboard("vllm-grafana-v2.json"),
};
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
const LOKI_VERSION = "3.2.1";
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
    // Dynamic scrape targets for "expose metrics" jobs (e.g. vLLM serving
    // on :8000). Aura rewrites /etc/prometheus/sd/jobs.json after every
    // metricsPort change and POSTs /-/reload, so Prometheus picks up
    // new vLLM jobs within seconds without us regenerating prometheus.yml.
    "  - job_name: aura-job",
    "    file_sd_configs:",
    "      - files:",
    "          - /etc/prometheus/sd/jobs.json",
    "        refresh_interval: 30s",
  ].join("\n");

  // Resolve aura's external origin from the deploy request so Grafana's
  // root_url generates absolute URLs that reach our reverse-proxy. We take
  // the first available of: X-Forwarded-Proto/Host (when behind another
  // proxy), then the request's host header. Falls back to localhost so a
  // dev-mode deploy still produces a valid (if local-only) URL.
  // Resolve the public origin Aura is reachable at. Order:
  //   1. AURA_PUBLIC_URL env (deployment-stable, recommended for prod —
  //      avoids baking dev/localhost into Grafana's root_url)
  //   2. X-Forwarded-Proto / X-Forwarded-Host (when behind a reverse proxy)
  //   3. Host header on the request itself (works in dev)
  // root_url gets baked into grafana.ini at startup; if it ever drifts the
  // admin has to re-deploy. The status endpoint reports it back so the UI
  // can surface a "needs redeploy" warning when the origin shifts.
  let rootUrl: string;
  const publicUrl = (process.env.AURA_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (publicUrl) {
    rootUrl = `${publicUrl}/grafana-proxy/${id}/`;
  } else {
    const proto = (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim();
    const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost").split(",")[0].trim();
    rootUrl = `${proto}://${host}/grafana-proxy/${id}/`;
  }
  const host = new URL(rootUrl).host;

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

  // Provision Prometheus (always) + Loki (when enabled) datasources. They
  // point at localhost on the stack host because everything runs on the
  // same machine.
  const lokiEnabled = !!metrics.lokiEnabled;
  const datasourcesYaml = `apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://localhost:${metrics.prometheusPort}
    isDefault: true
    editable: true
${lokiEnabled ? `  - name: Loki
    uid: loki
    type: loki
    access: proxy
    url: http://localhost:${metrics.lokiPort}
    editable: true
` : ""}`;

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

  // Loki config — single-binary mode, filesystem chunks, in-memory ring.
  // Suited for one-host log aggregation on a small cluster; not meant for
  // HA. Retention enforced by the compactor.
  const lokiDataDir = `${dataPath}/loki`;
  const lokiYml = `auth_enabled: false
server:
  http_listen_port: ${metrics.lokiPort}
  grpc_listen_port: 0
# instance_addr explicit so the ring doesn't try to auto-discover via the
# host's IP — single-binary mode in 3.x bails with 503 on /ready when
# auto-discovery fails (no eth0 with a routable IP, multiple NICs, etc).
common:
  instance_addr: 127.0.0.1
  path_prefix: ${lokiDataDir}
  storage:
    filesystem:
      chunks_directory: ${lokiDataDir}/chunks
      rules_directory: ${lokiDataDir}/rules
  replication_factor: 1
  ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: inmemory
schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h
limits_config:
  retention_period: ${metrics.lokiRetention}
  reject_old_samples: true
  reject_old_samples_max_age: 168h
  allow_structured_metadata: true
# Compactor: retention enforcement + log deletion. delete_request_store
# must point at one of the storage stanzas defined under common.storage —
# "filesystem" matches what we set above. Loki refuses to start otherwise.
# The compactor's ~10min "wait for ring to stay stable" delay still keeps
# /ready returning 503 on cold start; we work around that by querying
# /ready?excluded_module=compactor in the deploy probe and status check
# (the compactor isn't required for ingest/query — only retention).
compactor:
  working_directory: ${lokiDataDir}/compactor
  retention_enabled: true
  delete_request_store: filesystem
  compactor_ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: inmemory
ruler:
  storage:
    type: local
    local:
      directory: ${lokiDataDir}/rules
  rule_path: ${lokiDataDir}/rules-tmp
  ring:
    kvstore:
      store: inmemory
analytics:
  reporting_enabled: false
`;

  // The hand-rolled minimal dashboard below is replaced by the three
  // exported dashboards in web/dashboards/ (classic / v1 / v2 — picked
  // up at deploy time and shipped via base64). We keep this stub here as
  // a fallback when the JSON files are missing from the build (e.g. dev
  // checkout without them). It uses model_name as the templating var so
  // it's still useful on its own.
  const vllmDashboard = {
    title: "vLLM Serving",
    uid: "aura-vllm",
    schemaVersion: 39,
    version: 1,
    refresh: "30s",
    time: { from: "now-1h", to: "now" },
    timepicker: {},
    tags: ["aura", "vllm"],
    templating: {
      list: [
        {
          name: "ds",
          type: "datasource",
          query: "prometheus",
          current: { selected: false, text: "Prometheus", value: "prometheus" },
        },
        {
          name: "model_name",
          type: "query",
          datasource: { type: "prometheus", uid: "prometheus" },
          query: { query: "label_values(vllm:num_requests_running, model_name)", refId: "vllm-models" },
          refresh: 2,
          includeAll: true,
          multi: true,
          current: { selected: true, text: "All", value: "$__all" },
        },
      ],
    },
    panels: [
      {
        id: 1, type: "timeseries", title: "Running requests",
        gridPos: { x: 0, y: 0, w: 12, h: 7 },
        datasource: { type: "prometheus", uid: "prometheus" },
        targets: [{ refId: "A", expr: 'sum by (model_name) (vllm:num_requests_running{model_name=~"$model_name"})', legendFormat: "{{model_name}}" }],
      },
      {
        id: 2, type: "timeseries", title: "Waiting / pending requests",
        gridPos: { x: 12, y: 0, w: 12, h: 7 },
        datasource: { type: "prometheus", uid: "prometheus" },
        targets: [{ refId: "A", expr: 'sum by (model_name) (vllm:num_requests_waiting{model_name=~"$model_name"})', legendFormat: "{{model_name}}" }],
      },
      {
        id: 3, type: "timeseries", title: "GPU KV cache usage (%)",
        gridPos: { x: 0, y: 7, w: 12, h: 7 },
        fieldConfig: { defaults: { unit: "percentunit", min: 0, max: 1 } },
        datasource: { type: "prometheus", uid: "prometheus" },
        targets: [{ refId: "A", expr: 'avg by (model_name, instance) (vllm:gpu_cache_usage_perc{model_name=~"$model_name"})', legendFormat: "{{model_name}} / {{instance}}" }],
      },
      {
        id: 4, type: "timeseries", title: "Generation throughput (tokens/s)",
        gridPos: { x: 12, y: 7, w: 12, h: 7 },
        datasource: { type: "prometheus", uid: "prometheus" },
        targets: [{ refId: "A", expr: 'sum by (model_name) (rate(vllm:request_generation_tokens_sum{model_name=~"$model_name"}[1m]))', legendFormat: "{{model_name}}" }],
      },
      {
        id: 5, type: "timeseries", title: "Time-to-first-token p50 / p95 / p99 (s)",
        gridPos: { x: 0, y: 14, w: 12, h: 7 },
        fieldConfig: { defaults: { unit: "s" } },
        datasource: { type: "prometheus", uid: "prometheus" },
        targets: [
          { refId: "p50", expr: 'histogram_quantile(0.5, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket{model_name=~"$model_name"}[5m])))', legendFormat: "p50 / {{model_name}}" },
          { refId: "p95", expr: 'histogram_quantile(0.95, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket{model_name=~"$model_name"}[5m])))', legendFormat: "p95 / {{model_name}}" },
          { refId: "p99", expr: 'histogram_quantile(0.99, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket{model_name=~"$model_name"}[5m])))', legendFormat: "p99 / {{model_name}}" },
        ],
      },
      {
        id: 6, type: "timeseries", title: "End-to-end request latency p50 / p95 (s)",
        gridPos: { x: 12, y: 14, w: 12, h: 7 },
        fieldConfig: { defaults: { unit: "s" } },
        datasource: { type: "prometheus", uid: "prometheus" },
        targets: [
          { refId: "p50", expr: 'histogram_quantile(0.5, sum by (le, model_name) (rate(vllm:e2e_request_latency_seconds_bucket{model_name=~"$model_name"}[5m])))', legendFormat: "p50 / {{model_name}}" },
          { refId: "p95", expr: 'histogram_quantile(0.95, sum by (le, model_name) (rate(vllm:e2e_request_latency_seconds_bucket{model_name=~"$model_name"}[5m])))', legendFormat: "p95 / {{model_name}}" },
        ],
      },
      {
        id: 7, type: "stat", title: "Models being served",
        gridPos: { x: 0, y: 21, w: 6, h: 4 },
        datasource: { type: "prometheus", uid: "prometheus" },
        targets: [{ refId: "A", expr: 'count(count by (model_name) (vllm:num_requests_running))' }],
      },
      {
        id: 8, type: "stat", title: "Total running requests",
        gridPos: { x: 6, y: 21, w: 6, h: 4 },
        datasource: { type: "prometheus", uid: "prometheus" },
        targets: [{ refId: "A", expr: 'sum(vllm:num_requests_running)' }],
      },
    ],
  };
  const vllmDashJson = JSON.stringify(vllmDashboard);

  // base64-encode all configs so heredoc quoting / shell expansion never
  // mangles colons, quotes, or backticks. The remote side decodes them
  // verbatim.
  const promB64 = Buffer.from(promYml).toString("base64");
  const grafB64 = Buffer.from(grafanaIni).toString("base64");
  const dsB64 = Buffer.from(datasourcesYaml).toString("base64");
  const dbB64 = Buffer.from(dashboardsYaml).toString("base64");
  const lokiB64 = Buffer.from(lokiYml).toString("base64");
  const vllmDashB64 = Buffer.from(vllmDashJson).toString("base64");

  // Real vLLM dashboard exports (classic / v1 / v2) shipped from
  // web/dashboards/. Each one comes from `tryReadDashboard`; missing
  // entries are silently skipped so a dev checkout without the files
  // still deploys (falls back to the minimal stub above).
  const vllmExports = Object.entries(VLLM_DASHBOARDS)
    .filter(([, json]) => json !== null)
    .map(([name, json]) => ({ name, b64: Buffer.from(json as string).toString("base64") }));

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

$S mkdir -p /etc/prometheus /etc/prometheus/sd ${promDataDir}
echo "${promB64}" | base64 -d | $S tee /etc/prometheus/prometheus.yml >/dev/null
# Initialise the file_sd targets file with an empty array so the
# first-startup "no such file" warning doesn't show up. /metrics/refresh-
# targets rewrites this every time a Job's metricsPort changes.
[ -f /etc/prometheus/sd/jobs.json ] || echo '[]' | $S tee /etc/prometheus/sd/jobs.json >/dev/null
$S chown -R prometheus:prometheus ${promDataDir} /etc/prometheus/sd
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

${lokiEnabled ? `############################################################
# Loki binary + systemd unit (optional log aggregation)
############################################################
echo "[loki] installing v${LOKI_VERSION} ($NEARCH)..."
$S id loki >/dev/null 2>&1 || $S useradd --no-create-home --shell /usr/sbin/nologin loki

if [ ! -x /usr/local/bin/loki ] || ! /usr/local/bin/loki --version 2>&1 | grep -q "${LOKI_VERSION}"; then
  TMP=$(mktemp -d)
  cd "$TMP"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://github.com/grafana/loki/releases/download/v${LOKI_VERSION}/loki-linux-$NEARCH.zip" -o loki.zip
  else
    wget -q "https://github.com/grafana/loki/releases/download/v${LOKI_VERSION}/loki-linux-$NEARCH.zip" -O loki.zip
  fi
  # unzip is part of base on most distros; fall back to busybox / bsdtar.
  if command -v unzip >/dev/null 2>&1; then
    unzip -o loki.zip
  elif command -v bsdtar >/dev/null 2>&1; then
    bsdtar xf loki.zip
  else
    $S apt-get install -y -qq unzip 2>/dev/null || $S dnf install -y unzip 2>/dev/null || true
    unzip -o loki.zip
  fi
  $S install -m 0755 loki-linux-$NEARCH /usr/local/bin/loki
  cd / && rm -rf "$TMP"
else
  echo "[loki] binary already up to date"
fi

$S mkdir -p /etc/loki ${lokiDataDir} ${lokiDataDir}/chunks ${lokiDataDir}/rules ${lokiDataDir}/compactor
echo "${lokiB64}" | base64 -d | $S tee /etc/loki/loki.yaml >/dev/null
$S chown -R loki:loki ${lokiDataDir} /etc/loki

$S tee /etc/systemd/system/loki.service >/dev/null <<UNIT
[Unit]
Description=Loki log aggregator
After=network.target

[Service]
User=loki
Group=loki
Type=simple
ExecStart=/usr/local/bin/loki -config.file=/etc/loki/loki.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

$S systemctl daemon-reload
$S systemctl enable loki
$S systemctl restart loki
` : `############################################################
# Loki DISABLED in cluster config — tear down Loki on the stack host
# AND sweep promtail off every node (since they were paired together).
############################################################
echo "[loki] log aggregation disabled in config — tearing down"
if systemctl list-unit-files 2>/dev/null | grep -q '^loki\\.service'; then
  echo "[loki] stopping & disabling unit"
  $S systemctl disable --now loki 2>&1 | tail -3
  $S rm -f /etc/systemd/system/loki.service /usr/local/bin/loki
  $S rm -rf /etc/loki ${lokiDataDir}
  $S systemctl daemon-reload 2>/dev/null || true
  $S id loki >/dev/null 2>&1 && $S userdel loki 2>/dev/null || true
  echo "[loki] removed"
else
  echo "[loki] no unit installed — nothing to remove on stack host"
fi

echo "[promtail] sweeping every node to remove promtail (lokiEnabled=false)"
${(config.slurm_hosts_entries as Array<{ hostname: string; ip: string; user?: string; port?: number }> ?? []).map((h) => {
  const u = h.user || "root";
  const p = h.port || 22;
  return `
echo "[promtail] [${h.hostname}] removing..."
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p ${p} ${u}@${h.ip} bash -s <<'PT_EOF' || echo "[promtail] [${h.hostname}] ssh failed (skipping)"
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"
if systemctl list-unit-files 2>/dev/null | grep -q '^promtail\\.service'; then
  $S systemctl disable --now promtail 2>&1 | tail -3
  $S rm -f /etc/systemd/system/promtail.service /usr/local/bin/promtail
  $S rm -rf /etc/promtail /var/lib/promtail
  $S systemctl daemon-reload 2>/dev/null || true
  echo "  removed"
else
  echo "  no promtail unit — nothing to do"
fi
PT_EOF`;
}).join("\n")}
`}
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
# Real vLLM dashboard exports shipped with the build (web/dashboards/).
# These reference the victoria-metrics-prom datasource uid; we rewrite to
# our provisioned "prometheus" uid in the sed pass below alongside the
# upstream DCGM dashboards. The hand-rolled minimal stub goes alongside
# them as a fallback (always written so even a partial dashboard outage
# leaves something useful).
echo "${vllmDashB64}" | base64 -d | $S tee /etc/grafana/provisioning/dashboards/aura-gpu/vllm-grafana.json >/dev/null
${vllmExports.map((e) => `echo "${e.b64}" | base64 -d | $S tee /etc/grafana/provisioning/dashboards/aura-gpu/${e.name} >/dev/null`).join("\n")}

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
    -e 's/"uid": *"victoria-metrics-prom"/"uid": "prometheus"/g' \\
    -e 's/"datasource": *"victoria-metrics-prom"/"datasource": "prometheus"/g' \\
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
${lokiEnabled ? `LOKI_OK=0
# excluded_module=compactor avoids waiting on the compactor's ring-stability
# delay (which can be minutes on cold start). Loki accepts pushes / queries
# long before the compactor passes /ready; we only need it for retention.
for i in 1 2 3 4 5 6 7 8; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${metrics.lokiPort}/ready?excluded_module=compactor" 2>/dev/null || echo "000")
  if [ "$CODE" = "200" ]; then echo "[loki] ready (HTTP $CODE)"; LOKI_OK=1; break; fi
  echo "[loki] not ready ($CODE) — retry $i/8"
  sleep 2
done
if [ "$LOKI_OK" != "1" ]; then
  echo "[loki] FAILED to become ready — last 40 lines of journal:"
  $S journalctl -u loki -n 40 --no-pager 2>&1 | sed 's/^/  /' || true
fi
` : ""}
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
        // Persist the rotated admin password regardless of overall success.
        // The reset-admin-password CLI runs early in the script, so by the
        // time anything later fails (Loki probe, dashboard download, …),
        // Grafana's DB already has the new password. If we ONLY saved on
        // success, Aura would keep injecting the previous password and
        // every proxy request would 401 → login screen.
        try {
          const fresh = await prisma.cluster.findUnique({ where: { id } });
          if (fresh) {
            const next = mergeMetricsConfig(fresh.config, {
              enabled: true,
              grafanaAdminPassword: grafanaPassword,
              grafanaDeployedAt: new Date().toISOString(),
              grafanaRootUrl: rootUrl,
            });
            await prisma.cluster.update({
              where: { id },
              data: { config: next as never },
            });
          }
        } catch {}
        if (success) {
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
