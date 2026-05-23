/**
 * Synchronous accounting-apply endpoint for programmatic / CLI use.
 *
 * Mirrors POST /api/clusters/[id]/accounting/apply but:
 *   - Bearer-token auth (getApiUser).
 *   - Blocks until the remote script finishes and returns full
 *     stdout / stderr in the JSON response.
 *   - Skips BackgroundTask + audit so the run is fast to iterate
 *     during ansible/script development.
 *
 *   curl -X POST -H "Authorization: Bearer aura_…" \
 *     -H "Content-Type: application/json" \
 *     -d '{"mode":"slurmdbd"}' \
 *     http://localhost:3000/api/v1/clusters/<id>/accounting
 *
 * Body: { mode: "slurmdbd" | "none" | "fifo" }
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";
import {
  buildEnableSlurmdbdScript,
  buildDisableAccountingScript,
  buildFifoSchedulerScript,
} from "@/lib/accounting-script";

interface RouteParams { params: Promise<{ cluster: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { cluster: id } = await params;

  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const mode: "none" | "slurmdbd" | "fifo" =
    body.mode === "slurmdbd" ? "slurmdbd" :
    body.mode === "fifo" ? "fifo" : "none";

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  // Collect users to register at enable time, same shape as the UI path.
  const clusterUsers = await prisma.clusterUser.findMany({
    where: { clusterId: id, status: "ACTIVE" },
    include: { user: { select: { unixUsername: true, email: true } } },
  });
  const usernames = clusterUsers
    .map((cu) => cu.user.unixUsername ?? cu.user.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase())
    .filter(Boolean);

  const clusterSlurmName =
    (cluster.config as Record<string, unknown>).slurm_cluster_name as string ?? "aura-cluster";

  // Reuse the existing storage password when present so a re-apply
  // doesn't break the existing MariaDB user.
  const existingPass = (cluster.config as Record<string, unknown>).vault_slurmdbd_storage_pass as string ?? "";
  const dbPass = existingPass && existingPass.length > 0
    ? existingPass
    : randomUUID().replace(/-/g, "");

  const script =
    mode === "fifo" ? buildFifoSchedulerScript() :
    mode === "none" ? buildDisableAccountingScript() :
    buildEnableSlurmdbdScript({ dbPass, clusterSlurmName, usernames });

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
    proxyCommand: cluster.sshProxyCommand,
    jumpProxyCommand: cluster.sshJumpProxyCommand,
  };

  const start = Date.now();
  let stdoutBuf = "";
  let stderrBuf = "";

  const success = await new Promise<boolean>((resolve) => {
    sshExecScript(target, script, {
      // Match the UI path (commit 4966c73): installing MariaDB + slurmdbd
      // easily exceeds the 60s default ssh watchdog.
      timeoutMs: 15 * 60 * 1000,
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "");
        if (line.startsWith("[stderr]")) stderrBuf += line.slice(8) + "\n";
        else stdoutBuf += trimmed + "\n";
      },
      onComplete: (ok) => resolve(ok),
    });
  });
  const durationMs = Date.now() - start;

  // Persist the accounting decision into cluster.config so the next
  // Bootstrap doesn't undo it.
  if (success) {
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
  }

  const out = {
    status: success ? "success" : "failed",
    mode,
    durationMs,
    clusterId: id,
    clusterName: cluster.name,
    stdout: stdoutBuf,
    stderr: stderrBuf,
  };
  return NextResponse.json(out, { status: success ? 200 : 500 });
}
