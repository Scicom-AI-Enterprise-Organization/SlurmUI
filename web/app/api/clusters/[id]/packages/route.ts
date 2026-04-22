import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { publishCommand } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

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

// GET /api/clusters/[id]/packages — list installed packages from config
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = cluster.config as Record<string, unknown>;
  const packages: string[] = (config.installed_packages as string[]) ?? [];

  const latestTask = await prisma.backgroundTask.findFirst({
    where: { clusterId: id, type: "install_packages" },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, createdAt: true },
  });

  return NextResponse.json({ packages, latestTask });
}

// PUT /api/clusters/[id]/packages — update the package list in config (no install)
export async function PUT(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const packages: string[] = body.packages ?? [];

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = cluster.config as Record<string, unknown>;
  await prisma.cluster.update({
    where: { id },
    data: { config: { ...config, installed_packages: packages } as any },
  });

  return NextResponse.json({ packages });
}

// DELETE /api/clusters/[id]/packages — uninstall packages from all nodes
// and drop them from the cluster config. Body: { packages: string[] }.
// Runs `apt-get remove -y <pkgs>` over SSH on each worker, streams to a
// BackgroundTask the UI can poll.
export async function DELETE(req: NextRequest, { params }: RouteParams) {
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
  if (cluster.status !== "ACTIVE" && cluster.status !== "DEGRADED") {
    return NextResponse.json({ error: "Cluster is not active" }, { status: 503 });
  }

  const body = await req.json();
  const packages: string[] = body.packages ?? [];
  if (packages.length === 0) {
    return NextResponse.json({ error: "No packages specified" }, { status: 400 });
  }

  const config = cluster.config as Record<string, unknown>;
  // Do NOT drop the packages from the stored list here — only after the
  // background apt-get remove actually succeeds on every node. Otherwise
  // a failed SSH script (e.g. bastion truncation, network blip) leaves
  // the DB saying "uninstalled" while apt still has the package.

  if (cluster.connectionMode === "SSH") {
    if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

    const task = await prisma.backgroundTask.create({
      data: { clusterId: id, type: "remove_packages" },
    });

    const target = {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
    };

    const controllerHost = config.slurm_controller_host as string;
    const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
    const workers = hostsEntries.filter((h) => h.hostname !== controllerHost);
    const targets = workers.length > 0 ? workers : hostsEntries;
    const pkgList = packages.join(" ");

    const workerBlock = targets.map((w) => {
      const u = w.user || "root";
      const p = w.port || 22;
      // Ship commands via a short multi-line heredoc rather than one
      // 300+ char `bash -c '...'` single-liner. Long single lines inside
      // bash scripts uploaded over bastion PTY occasionally get truncated
      // in canonical mode and bash barfs on the opening quote.
      return `
echo "  Removing on ${w.hostname} (${w.ip})..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${w.ip} bash -s <<'NODE_EOF'
S=""; [ "$(id -u)" != "0" ] && S=sudo
export DEBIAN_FRONTEND=noninteractive
$S apt-get remove -y -qq ${pkgList} 2>&1 | grep -E "^(Removing|Purging|Not installed)" | head -20 || true
$S apt-get autoremove -y -qq 2>&1 | tail -3
echo "  done on ${w.hostname}"
NODE_EOF`;
    }).join("\n");

    const script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT

echo "============================================"
echo "  Removing packages: ${pkgList}"
echo "  Targets: ${targets.length} node(s)"
echo "============================================"
echo ""
${workerBlock}
echo ""
echo "============================================"
echo "  Removal complete"
echo "============================================"
`;

    (async () => {
      await appendLog(task.id, `[aura] Removing ${packages.length} package(s): ${pkgList}`);
      const handle = sshExecScript(target, script, {
        onStream: (line) => {
          const trimmed = line.replace(/\r/g, "").trim();
          if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
            appendLog(task.id, trimmed);
          }
        },
        onComplete: async (success) => {
          if (success) {
            // Apt-remove worked — now strip the package(s) from the stored
            // cluster config. Fetch fresh to avoid clobbering concurrent
            // admin edits to other fields.
            try {
              const fresh = await prisma.cluster.findUnique({ where: { id } });
              if (fresh) {
                const cfg = (fresh.config ?? {}) as Record<string, unknown>;
                const list: string[] = (cfg.installed_packages as string[]) ?? [];
                const remaining = list.filter((p) => !packages.includes(p));
                await prisma.cluster.update({
                  where: { id },
                  data: { config: { ...cfg, installed_packages: remaining } as any },
                });
              }
            } catch {}
            await appendLog(task.id, "\n[aura] Packages removed successfully.");
            logAudit({ action: "packages.remove", entity: "Cluster", entityId: id, metadata: { packages, mode: "ssh" } });
          } else {
            await appendLog(task.id, "\n[aura] Package removal failed or was cancelled.");
          }
          await finishTask(task.id, success);
        },
      });
      registerRunningTask(task.id, handle);
    })();

    return NextResponse.json({ taskId: task.id });
  }

  // NATS mode
  const nodes: Array<{ hostname: string; ip: string }> =
    (config.slurm_hosts_entries as any) ?? [];
  const workerHosts = nodes
    .filter((n) => n.hostname !== cluster.controllerHost)
    .map((n) => ({ hostname: n.hostname, ip: n.ip }));

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "remove_packages",
    payload: { packages, worker_hosts: workerHosts },
  });

  await logAudit({ action: "packages.remove", entity: "Cluster", entityId: id, metadata: { packages, mode: "nats" } });
  return NextResponse.json({ request_id: requestId });
}

// POST /api/clusters/[id]/packages — install packages on all nodes
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
  if (cluster.status !== "ACTIVE" && cluster.status !== "DEGRADED") {
    return NextResponse.json({ error: "Cluster is not active" }, { status: 503 });
  }

  const body = await req.json();
  const packages: string[] = body.packages ?? [];
  if (packages.length === 0) {
    return NextResponse.json({ error: "No packages specified" }, { status: 400 });
  }

  const config = cluster.config as Record<string, unknown>;

  // Persist to config
  const existing: string[] = (config.installed_packages as string[]) ?? [];
  const merged = Array.from(new Set([...existing, ...packages]));
  await prisma.cluster.update({
    where: { id },
    data: { config: { ...config, installed_packages: merged } as any },
  });

  // SSH mode: background task
  if (cluster.connectionMode === "SSH") {
    if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

    const task = await prisma.backgroundTask.create({
      data: { clusterId: id, type: "install_packages" },
    });

    const target = {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
    };

    const controllerHost = config.slurm_controller_host as string;
    const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
    const workers = hostsEntries.filter((h) => h.hostname !== controllerHost);
    const targets = workers.length > 0 ? workers : hostsEntries;
    const pkgList = packages.join(" ");

    const workerBlock = targets.map((w) => {
      const u = w.user || "root";
      const p = w.port || 22;
      // Multi-line heredoc over one long `bash -c '...'` single-liner —
      // the latter was hitting "unexpected EOF" parse errors on bastion
      // because the decoded script's 300+ char ssh line occasionally got
      // clipped by the remote PTY.
      return `
echo "  Installing on ${w.hostname} (${w.ip})..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${w.ip} bash -s <<'NODE_EOF'
S=""; [ "$(id -u)" != "0" ] && S=sudo
export DEBIAN_FRONTEND=noninteractive
$S apt-get update -qq 2>&1 | tail -3
$S apt-get install -y -qq ${pkgList} 2>&1 | grep -E "^(Setting up|already)" | head -20 || true
echo "  done on ${w.hostname}"
NODE_EOF`;
    }).join("\n");

    const script = `#!/bin/bash
set -euo pipefail

echo "============================================"
echo "  Installing packages: ${pkgList}"
echo "  Targets: ${targets.length} node(s)"
echo "============================================"
echo ""
${workerBlock}
echo ""
echo "============================================"
echo "  Installation complete"
echo "============================================"
`;

    // Run in background
    (async () => {
      await appendLog(task.id, `[aura] Installing ${packages.length} package(s): ${pkgList}`);
      const handle = sshExecScript(target, script, {
        onStream: (line) => {
          const trimmed = line.replace(/\r/g, "").trim();
          if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
            appendLog(task.id, trimmed);
          }
        },
        onComplete: async (success) => {
          if (success) {
            await appendLog(task.id, "\n[aura] Packages installed successfully.");
            logAudit({ action: "packages.install", entity: "Cluster", entityId: id, metadata: { packages, mode: "ssh" } });
          } else {
            await appendLog(task.id, "\n[aura] Package installation failed or was cancelled.");
          }
          await finishTask(task.id, success);
        },
      });
      registerRunningTask(task.id, handle);
    })();

    return NextResponse.json({ taskId: task.id });
  }

  // NATS mode
  const nodes: Array<{ hostname: string; ip: string }> =
    (config.slurm_hosts_entries as any) ?? [];
  const workerHosts = nodes
    .filter((n) => n.hostname !== cluster.controllerHost)
    .map((n) => ({ hostname: n.hostname, ip: n.ip }));

  const sshPrivateKey = cluster.sshKey
    ? Buffer.from(cluster.sshKey.privateKey).toString("base64")
    : "";

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "install_packages",
    payload: { packages, worker_hosts: workerHosts, ssh_private_key: sshPrivateKey },
  });

  await logAudit({ action: "packages.install", entity: "Cluster", entityId: id, metadata: { packages, mode: "nats" } });

  return NextResponse.json({ request_id: requestId });
}
