/**
 * Synchronous bootstrap endpoint for programmatic / CLI use.
 *
 * Differs from POST /api/clusters/[id]/bootstrap (which the UI uses):
 *   - Bearer-token auth via getApiUser (no session cookie needed).
 *   - Runs ansible-playbook in the foreground and BLOCKS until it
 *     finishes; returns the full stdout + stderr in the JSON response.
 *   - Skips BackgroundTask / audit / controller-auto-seed /
 *     accounting-auto-enable post-steps so the run is fast to iterate
 *     against during ansible-role development.
 *   - On a non-zero ansible exit code, returns HTTP 500 with the logs
 *     so the caller can grep for the failing task and re-iterate.
 *
 * Auth: Bearer aura_* (admin only). Use:
 *
 *   curl -X POST \
 *     -H "Authorization: Bearer aura_…" \
 *     http://localhost:3000/api/v1/clusters/<id>/bootstrap
 *
 * Path is under /api/v1/ so the session-cookie gate in middleware.ts
 * doesn't intercept the Bearer-auth request.
 */
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { buildInventory } from "@/lib/bootstrap-inventory";
import { seedDefaultPartition } from "@/lib/bootstrap-seed";

interface RouteParams { params: Promise<{ cluster: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  // Slug is `cluster` (matches the sibling /api/v1/clusters/[cluster]/jobs
  // route — Next refuses to mix [id] and [cluster] under the same path).
  const { cluster: id } = await params;

  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key assigned" }, { status: 412 });

  const playbookDir = process.env.ANSIBLE_PLAYBOOKS_DIR ?? "/opt/aura/ansible";
  const playbookFile = process.env.ANSIBLE_PLAYBOOK ?? "bootstrap.yml";

  let config = (cluster.config ?? {}) as Record<string, unknown>;
  config = { ...config, aura_cluster_id: id };
  if (process.env.AURA_AGENT_BINARY_SRC) {
    config = { ...config, aura_agent_binary_src: process.env.AURA_AGENT_BINARY_SRC };
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "aura-bootstrap-v1-"));
  const inventoryPath = join(tmpDir, "inventory.ini");
  const configPath = join(tmpDir, "cluster-config.json");
  const sshKeyFile = join(tmpDir, "ssh_key");
  writeFileSync(sshKeyFile, cluster.sshKey.privateKey, { mode: 0o600 });
  writeFileSync(inventoryPath, buildInventory({
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    sshKeyFile,
    proxyCommand: cluster.sshProxyCommand,
  }, config));
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const start = Date.now();
  // Buffer stdout/stderr in-memory. ansible-playbook on a real cluster
  // can emit ~MBs of log over a multi-minute run, so cap at a generous
  // limit (8 MiB) to avoid OOM on a pathological play.
  const MAX_BYTES = 8 * 1024 * 1024;
  let stdoutBuf = "";
  let stderrBuf = "";
  const appendCap = (which: "out" | "err") => (chunk: Buffer) => {
    const slot = which === "out" ? stdoutBuf : stderrBuf;
    const remaining = MAX_BYTES - slot.length;
    if (remaining <= 0) return;
    const piece = chunk.toString().slice(0, remaining);
    if (which === "out") stdoutBuf += piece;
    else stderrBuf += piece;
  };

  const { exitCode } = await new Promise<{ exitCode: number | null }>((resolve) => {
    const proc = spawn("ansible-playbook", [
      "-i", inventoryPath,
      "-e", `@${configPath}`,
      "--diff",
      join(playbookDir, playbookFile),
    ], {
      env: {
        ...process.env,
        ANSIBLE_FORCE_COLOR: "0",
        ANSIBLE_NOCOLOR: "1",
        ANSIBLE_HOST_KEY_CHECKING: "False",
      },
    });
    proc.stdout.on("data", appendCap("out"));
    proc.stderr.on("data", appendCap("err"));
    proc.on("close", (code) => resolve({ exitCode: code }));
    proc.on("error", (err) => {
      stderrBuf += `\n[spawn-error] ${err.message}`;
      resolve({ exitCode: -1 });
    });
  });

  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const durationMs = Date.now() - start;
  const success = exitCode === 0;

  // On success update the cluster's status the same way the UI path does
  // — otherwise the API consumer would have to issue a second PATCH.
  if (success) {
    await prisma.cluster.update({
      where: { id },
      data: { status: "ACTIVE" },
    }).catch(() => {});
    // Mirror the template's default partition into cluster.config so the
    // UI's Partitions tab and the New Job form's dropdown both render
    // without an extra round-trip. No-op when the user has already added
    // partitions via the Partitions tab.
    await seedDefaultPartition(id).catch(() => {});
  }

  const body = {
    status: success ? "success" : "failed",
    exitCode,
    durationMs,
    clusterId: id,
    clusterName: cluster.name,
    stdout: stdoutBuf,
    stderr: stderrBuf,
  };
  return NextResponse.json(body, { status: success ? 200 : 500 });
}
