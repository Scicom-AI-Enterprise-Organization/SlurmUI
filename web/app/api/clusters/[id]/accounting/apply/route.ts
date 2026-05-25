import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";
import { randomUUID } from "crypto";
import {
  buildEnableSlurmdbdScript,
  buildDisableAccountingScript,
  buildFifoSchedulerScript,
} from "@/lib/accounting-script";

interface RouteParams { params: Promise<{ id: string }> }

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

// POST /api/clusters/[id]/accounting/apply
//   body: { mode: "none" | "slurmdbd" }
//   - "none"     → strip AccountingStorageType / AccountingStorageEnforce,
//                  set AccountingStorageType=accounting_storage/none, restart slurmctld.
//   - "slurmdbd" → install + start MariaDB and slurmdbd, set AccountingStorageType
//                  to slurmdbd, register cluster account, then re-register ACTIVE
//                  cluster users so their accounts land in the DB.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const mode: "none" | "slurmdbd" | "fifo" =
    body.mode === "slurmdbd" ? "slurmdbd" :
    body.mode === "fifo" ? "fifo" : "none";

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const taskType =
    mode === "fifo" ? "priority_fifo" : `accounting_${mode}`;
  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: taskType },
  });

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
    // Honour the cluster's Host ProxyCommand (e.g. cloudflared access ssh).
    // Otherwise this route's SSH dial fails with "Network unreachable" on
    // tunnel-only controllers. Mirrors the fix applied to bootstrap (commit
    // 4966c73) and ansible inventory (commit 9f39bd3).
    proxyCommand: cluster.sshProxyCommand,
    jumpProxyCommand: cluster.sshJumpProxyCommand,
  };

  // Collect active cluster users so we can re-register them when enabling slurmdbd.
  const clusterUsers = await prisma.clusterUser.findMany({
    where: { clusterId: id, status: "ACTIVE" },
    include: { user: { select: { unixUsername: true, email: true } } },
  });
  const usernames = clusterUsers
    .map((cu) => cu.user.unixUsername ?? cu.user.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase())
    .filter(Boolean);

  const clusterSlurmName = (cluster.config as Record<string, unknown>).slurm_cluster_name as string ?? "aura-cluster";

  // Generate the slurmdbd storage password server-side so we can persist it
  // into cluster.config.vault_slurmdbd_storage_pass. Without this, the next
  // bootstrap would see an empty password, decide accounting is disabled,
  // and tear it back down. Reuse the existing password if one is already
  // stored so re-applying doesn't break existing MariaDB state.
  const existingPass = (cluster.config as Record<string, unknown>).vault_slurmdbd_storage_pass as string ?? "";
  const dbPass = existingPass && existingPass.length > 0
    ? existingPass
    : randomUUID().replace(/-/g, "");

  // Script builders moved to lib/accounting-script.ts so the synchronous
  // /api/v1/clusters/[cluster]/accounting variant can share them.
  const script =
    mode === "fifo" ? buildFifoSchedulerScript() :
    mode === "none" ? buildDisableAccountingScript() :
    buildEnableSlurmdbdScript({ dbPass, clusterSlurmName, usernames });

  (async () => {
    await appendLog(task.id, `[aura] Applying accounting mode: ${mode}`);
    const handle = sshExecScript(target, script, {
      // Enabling slurmdbd installs MariaDB + slurmdbd via apt and restarts
      // services — easily exceeds the 60s default. Match the same timeout
      // used by the bootstrap path's autoEnableAccounting (commit 4966c73).
      timeoutMs: 15 * 60 * 1000,
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(task.id, trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          // Persist the accounting decision into cluster.config so the next
          // Bootstrap doesn't undo it. The ansible role gates slurmdbd on
          // vault_slurmdbd_storage_pass — set it when enabling, clear on none.
          try {
            const freshCluster = await prisma.cluster.findUnique({ where: { id } });
            const cfg = (freshCluster?.config ?? {}) as Record<string, unknown>;
            if (mode === "slurmdbd") {
              cfg.vault_slurmdbd_storage_pass = dbPass;
            } else if (mode === "none") {
              cfg.vault_slurmdbd_storage_pass = "";
            }
            await prisma.cluster.update({
              where: { id },
              data: { config: cfg as never },
            });
          } catch {}
          await appendLog(task.id, `\n[aura] Accounting mode "${mode}" applied successfully.`);
          await logAudit({
            action: "cluster.accounting",
            entity: "Cluster",
            entityId: id,
            metadata: { mode, users: usernames.length },
          });
        } else {
          await appendLog(task.id, "\n[aura] Accounting change failed or was cancelled.");
        }
        await finishTask(task.id, success);
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id });
}
