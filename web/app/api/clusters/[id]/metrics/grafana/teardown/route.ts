import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";
import { mergeMetricsConfig, readMetricsConfig, resolveStackHost } from "@/lib/metrics-config";

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

const DEFAULT_DATA_PATH = "/var/lib/aura-metrics";

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  // auth: accepts both NextAuth session cookies and Bearer aura_* tokens.
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
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
  const stackHost = resolveStackHost(cluster.controllerHost, config, metrics);
  const dataPath = ((metrics.stackDataPath ?? "").trim() || DEFAULT_DATA_PATH).replace(/\/+$/, "");

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
    data: { clusterId: id, type: "metrics_grafana_teardown" },
  });

  const inner = `
S=""
[ "$(id -u)" != "0" ] && S="sudo"

# Pick the same supervisor as the deploy script picked. systemd presence is
# detected via /run/systemd/system; otherwise pm2-go is the container path.
if [ -d /run/systemd/system ]; then
  SUPERVISOR=systemd
elif command -v pm2 >/dev/null 2>&1 && [ -d /root/.pm2-go ]; then
  SUPERVISOR=pm2
else
  SUPERVISOR=none
fi
echo "[supervisor] tearing down via: $SUPERVISOR"

for svc in grafana prometheus loki; do
  if [ "$SUPERVISOR" = "systemd" ]; then
    if systemctl list-unit-files | grep -q "^\${svc}\\.service"; then
      echo "[\${svc}] stopping & disabling..."
      $S systemctl disable --now \${svc} 2>&1 | tail -3
      $S rm -f /etc/systemd/system/\${svc}.service
    fi
  elif [ "$SUPERVISOR" = "pm2" ]; then
    if [ -f /etc/aura/pm2/\${svc}.json ] || [ -f /root/.pm2-go/pids/\${svc}.pid ]; then
      echo "[\${svc}] stopping & deleting pm2 entry..."
      $S /usr/local/bin/pm2 delete \${svc} >/dev/null 2>&1 || true
      $S rm -f /etc/aura/pm2/\${svc}.json
    fi
  fi
done
# Persist the pm2 dump so the daemons don't resurrect on pm2 daemon resurrect.
[ "$SUPERVISOR" = "pm2" ] && setsid --wait /usr/local/bin/pm2 dump >/dev/null 2>&1 || true

$S rm -f /usr/local/bin/prometheus /usr/local/bin/promtool /usr/local/bin/loki
$S rm -rf /opt/grafana /opt/grafana-* /etc/prometheus /etc/grafana /etc/loki
$S rm -rf ${dataPath}

[ "$SUPERVISOR" = "systemd" ] && $S systemctl daemon-reload 2>/dev/null || true
echo "[stack] removed"
`;

  const u = stackHost.user || "root";
  const p = stackHost.port || 22;
  const remoteWrap = stackHost.isController
    ? inner
    : `
echo "[stack] Hopping to ${stackHost.hostname} (${stackHost.ip})..."
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p ${p} ${u}@${stackHost.ip} bash -s <<'STACK_EOF'
set +e
${inner}
STACK_EOF
`;

  const script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT
echo "[stack] tearing down on ${stackHost.hostname}${stackHost.isController ? " (controller)" : ""}"
${remoteWrap}
exit 0
`;

  (async () => {
    await appendLog(task.id, `[aura] Tearing down stack on ${stackHost.hostname}`);
    const handle = sshExecScript(target, script, {
      timeoutMs: 5 * 60 * 1000,
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
                grafanaAdminPassword: undefined,
                grafanaDeployedAt: undefined,
                grafanaRootUrl: undefined,
              });
              await prisma.cluster.update({ where: { id }, data: { config: next as never } });
            }
          } catch {}
          await logAudit({
            action: "metrics.grafana.teardown",
            entity: "Cluster",
            entityId: id,
            metadata: { stackHost: stackHost.hostname },
          });
          await appendLog(task.id, "\n[aura] Stack removed.");
        } else {
          await appendLog(task.id, "\n[aura] Teardown failed.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id, stackHost: stackHost.hostname });
}
