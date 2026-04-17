import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";

interface RouteParams { params: Promise<{ id: string }> }

interface EnvVar { key: string; value: string; secret?: boolean }
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

// POST — write /etc/profile.d/aura.sh on every node so the env vars load for
// every login shell (including sbatch's wrapper). Runs sequentially via SSH
// through the controller; survives dialog close like other long-running tasks.
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
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const config = cluster.config as Record<string, unknown>;
  const vars: EnvVar[] = (config.os_environment as EnvVar[]) ?? [];
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const targets = hostsEntries.length > 0
    ? hostsEntries
    : [{ hostname: cluster.controllerHost, ip: cluster.controllerHost }];

  // Generate the profile.d snippet. Double-quote values and escape ", \, $, `
  // so shell expansion / interpolation doesn't bite us.
  const shellEscape = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
  const profileBody = [
    "# Managed by Aura. Do not edit — changes will be overwritten.",
    "# Applied to every login shell via /etc/profile.d/aura.sh",
    ...vars.map((v) => `export ${v.key}="${shellEscape(v.value)}"`),
  ].join("\n");

  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: "apply_environment" },
  });

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  // Base64-encode the profile body so multiline values survive the SSH pipe.
  const b64 = Buffer.from(profileBody + "\n").toString("base64");

  const perHost = targets.map((h) => {
    const u = h.user || "root";
    const p = h.port || 22;
    return `
echo "[aura] Applying env to ${h.hostname} (${h.ip})..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p ${p} ${u}@${h.ip} bash -s <<'NODE_EOF'
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"
echo '${b64}' | base64 -d | $S tee /etc/profile.d/aura.sh > /dev/null
$S chmod 644 /etc/profile.d/aura.sh
echo "  wrote /etc/profile.d/aura.sh ($(wc -l < /etc/profile.d/aura.sh) lines)"
NODE_EOF`;
  }).join("\n");

  const script = `#!/bin/bash
set +e

echo "============================================"
echo "  Applying ${vars.length} env var(s) to ${targets.length} node(s)"
echo "============================================"
echo ""
${perHost}
echo ""
echo "[aura] Done. New jobs pick up these vars; existing shells don't until re-login."
`;

  (async () => {
    await appendLog(task.id, `[aura] Applying ${vars.length} env var(s) to ${targets.length} node(s)`);
    const handle = sshExecScript(target, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          await appendLog(task.id, "\n[aura] Environment applied successfully.");
          await logAudit({
            action: "environment.apply",
            entity: "Cluster",
            entityId: id,
            metadata: { count: vars.length, keys: vars.map((v) => v.key) },
          });
        } else {
          await appendLog(task.id, "\n[aura] Environment apply failed or was cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id });
}
