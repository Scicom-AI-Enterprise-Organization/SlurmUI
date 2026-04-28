import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";
import { mergeMetricsConfig, readMetricsConfig } from "@/lib/metrics-config";

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

const UNINSTALL_INNER = `
S=""
[ "$(id -u)" != "0" ] && S="sudo"

if systemctl list-unit-files | grep -q '^node_exporter\\.service'; then
  echo "[node_exporter] stopping & disabling..."
  $S systemctl disable --now node_exporter 2>&1 | tail -3
  $S rm -f /etc/systemd/system/node_exporter.service /usr/local/bin/node_exporter
fi

if systemctl list-unit-files | grep -q '^nvidia_gpu_exporter\\.service'; then
  echo "[nvidia_gpu_exporter] stopping & disabling..."
  $S systemctl disable --now nvidia_gpu_exporter 2>&1 | tail -3
  $S rm -f /etc/systemd/system/nvidia_gpu_exporter.service /usr/local/bin/nvidia_gpu_exporter
fi

if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -q '^aura-dcgm-exporter$'; then
  echo "[dcgm-exporter] stopping container..."
  $S docker rm -f aura-dcgm-exporter 2>&1 | tail -3
fi

if systemctl list-unit-files | grep -q '^promtail\\.service'; then
  echo "[promtail] stopping & disabling..."
  $S systemctl disable --now promtail 2>&1 | tail -3
  $S rm -f /etc/systemd/system/promtail.service /usr/local/bin/promtail
  $S rm -rf /etc/promtail /var/lib/promtail
fi

$S systemctl daemon-reload 2>/dev/null || true
echo "[done] exporters + promtail removed"
`;

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const targetHostnames: string[] | undefined = Array.isArray(body.hostnames) ? body.hostnames : undefined;

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const metrics = readMetricsConfig(config);
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const targets: HostEntry[] = (targetHostnames && targetHostnames.length > 0)
    ? hostsEntries.filter((h) => targetHostnames.includes(h.hostname))
    : hostsEntries.filter((h) => metrics.nodes[h.hostname]);
  if (targets.length === 0) {
    return NextResponse.json({ error: "No matching nodes" }, { status: 400 });
  }

  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: "metrics_uninstall" },
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

  const workerBlock = targets.map((h) => {
    const u = h.user || "root";
    const p = h.port || 22;
    return `
echo "============================================"
echo "  [${h.hostname}] Removing exporters..."
echo "============================================"
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p ${p} ${u}@${h.ip} bash -s <<'NODE_EOF'
set +e
${UNINSTALL_INNER}
NODE_EOF
echo ""`;
  }).join("\n");

  const script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

echo "============================================"
echo "  Metrics uninstall — ${targets.length} host(s)"
echo "============================================"
echo ""
${workerBlock}
echo "[aura] Done."
exit 0
`;

  (async () => {
    await appendLog(task.id, `[aura] Removing metrics exporters from ${targets.length} host(s)`);
    const handle = sshExecScript(target, script, {
      timeoutMs: 10 * 60 * 1000,
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
              const cfg = (fresh.config ?? {}) as Record<string, unknown>;
              const m = readMetricsConfig(cfg);
              const remaining = { ...m.nodes };
              for (const t of targets) delete remaining[t.hostname];
              const next = { ...cfg, metrics: { ...m, nodes: remaining } };
              await prisma.cluster.update({ where: { id }, data: { config: next as never } });
            }
          } catch {}
          await logAudit({
            action: "metrics.uninstall",
            entity: "Cluster",
            entityId: id,
            metadata: { hosts: targets.map((t) => t.hostname) },
          });
          await appendLog(task.id, "\n[aura] Metrics exporters removed.");
        } else {
          await appendLog(task.id, "\n[aura] Uninstall failed or was cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id, targets: targets.map((t) => t.hostname) });
}
