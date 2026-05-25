/**
 * Synchronous bootstrap endpoint for programmatic / CLI use.
 *
 * Differs from POST /api/clusters/[id]/bootstrap (which the UI uses):
 *   - Bearer-token auth via getApiUser (no session cookie needed).
 *   - Runs ansible-playbook in the foreground and BLOCKS until it
 *     finishes; returns the full stdout + stderr in the JSON response.
 *   - Skips BackgroundTask / audit post-steps so the run is fast to
 *     iterate against during ansible-role development.
 *   - Performs the same controller-auto-seed + slurmdbd accounting
 *     auto-enable that the UI bootstrap does (was an intentional skip;
 *     made consistent so v1 callers don't end up with no accounting
 *     silently). Opt out per-call with ?skipAccounting=true.
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
import { sshExecScript, sshExecSimple } from "@/lib/ssh-exec";
import { probeSlurmFirstJobId } from "@/lib/slurm-first-jobid";
import { buildEnableSlurmdbdScript } from "@/lib/accounting-script";
import { randomBytes } from "crypto";

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

  // Probe the controller's slurmdbd for the highest historical JobId and
  // set FirstJobId = max + 1. This makes the new slurmctld pick up where
  // slurmdbd left off, even when /var/spool/slurm was wiped on a prior
  // teardown (which resets the in-memory counter to 1). Default is 1 if
  // slurmdbd isn't reachable / is fresh — same as before the probe.
  try {
    const firstJobId = await probeSlurmFirstJobId({
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
      proxyCommand: cluster.sshProxyCommand,
      jumpProxyCommand: cluster.sshJumpProxyCommand,
    });
    config = { ...config, slurm_first_job_id: firstJobId };
  } catch {
    // best-effort; bootstrap continues with the default (FirstJobId=1)
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
  let seedDiag = "";
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
    // Probe the controller's real hostname / hw + add an entry to
    // slurm_hosts_entries + slurm_nodes. Without this, downstream paths
    // that look up the controller by hostname (NFS server provisioning,
    // mount deploy, scrape targets) all fail with "node not found". The
    // UI bootstrap calls the same logic inside its onClose handler; we
    // inline it here so v1 callers (CLI / tests / CI) get parity instead
    // of a partially-seeded cluster.
    try {
      seedDiag = await seedControllerInline(id, {
        host: cluster.controllerHost,
        user: cluster.sshUser,
        port: cluster.sshPort,
        privateKey: cluster.sshKey.privateKey,
        bastion: cluster.sshBastion,
        proxyCommand: cluster.sshProxyCommand,
        jumpProxyCommand: cluster.sshJumpProxyCommand,
      });
    } catch (e) {
      seedDiag = `seedControllerInline threw: ${e instanceof Error ? e.message : "unknown"}`;
    }
  }

  // Auto-enable slurmdbd accounting unless the caller passed
  // ?skipAccounting=true. Same logic the UI bootstrap runs as its final
  // step. Best-effort: failures are reported in `accountingDiagnostic`
  // but don't fail the whole bootstrap (slurm.conf is still functional
  // with accounting_storage/none — accounting can be retried via the
  // Accounting tab or POST /api/clusters/<id>/accounting/apply).
  const skipAccounting = req.nextUrl.searchParams.get("skipAccounting") === "true";
  let accountingDiag = "";
  if (success && !skipAccounting) {
    accountingDiag = await enableAccountingInline(id, {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
      proxyCommand: cluster.sshProxyCommand,
      jumpProxyCommand: cluster.sshJumpProxyCommand,
    }).catch((e) => `enableAccountingInline threw: ${e instanceof Error ? e.message : "unknown"}`);
  }

  const body = {
    status: success ? "success" : "failed",
    exitCode,
    durationMs,
    clusterId: id,
    clusterName: cluster.name,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    // Echo any post-bootstrap seed diagnostic into the response so the
    // caller (or our e2e test) can see *why* the controller didn't end
    // up in slurm_hosts_entries without re-running with extra
    // instrumentation. Empty on the happy path.
    seedDiagnostic: seedDiag || undefined,
    accountingDiagnostic: accountingDiag || undefined,
  };
  return NextResponse.json(body, { status: success ? 200 : 500 });
}

/**
 * Best-effort slurmdbd accounting auto-enable. Mirrors the same flow the
 * UI bootstrap runs as its final step: builds the enable script via the
 * shared accounting-script.ts helper, ssh-execs it on the controller,
 * then persists the generated DB password in cluster.config so a future
 * re-run reuses the same one (preserves accounting rows across bootstrap
 * re-runs). Returns a diagnostic string — empty on success.
 */
async function enableAccountingInline(clusterId: string, sshTarget: InlineSshTarget): Promise<string> {
  if (!sshTarget.privateKey) return "no ssh key — accounting skipped";
  const fresh = await prisma.cluster.findUnique({ where: { id: clusterId } });
  if (!fresh) return "cluster row vanished";
  const cfg = (fresh.config ?? {}) as Record<string, unknown>;
  const existingPass = (cfg.vault_slurmdbd_storage_pass as string) ?? "";
  const dbPass = existingPass || randomBytes(18).toString("base64url");
  const clusterSlurmName = (cfg.slurm_cluster_name as string) ?? fresh.name;
  // Re-register every active cluster user as a sacctmgr account, so
  // jobs submitted after this point land in the DB with the right
  // association. unixUsername lives on User (not ClusterUser); fall
  // back to a sanitised email-local-part if missing — same as the UI
  // bootstrap path.
  const clusterUsers = await prisma.clusterUser.findMany({
    where: { clusterId, status: "ACTIVE" },
    include: { user: { select: { unixUsername: true, email: true } } },
  }).catch(() => [] as Array<{ user: { unixUsername: string | null; email: string } }>);
  const usernames = clusterUsers
    .map((cu) => cu.user.unixUsername ?? cu.user.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase())
    .filter((u) => u.length > 0 && /^[a-z_][a-z0-9_-]*$/i.test(u));
  const script = buildEnableSlurmdbdScript({ dbPass, clusterSlurmName, usernames });
  const r = await sshExecSimple({
    host: sshTarget.host,
    user: sshTarget.user,
    port: sshTarget.port,
    privateKey: sshTarget.privateKey,
    bastion: sshTarget.bastion,
    proxyCommand: sshTarget.proxyCommand,
    jumpProxyCommand: sshTarget.jumpProxyCommand,
  }, script);
  if (!r.success) {
    return `accounting enable rc=${r.exitCode}: ${(r.stderr || r.stdout).slice(-400)}`;
  }
  // Persist password so the next bootstrap re-run uses the same one
  // and slurmdbd doesn't reject the existing rows on a credentials
  // mismatch.
  if (!existingPass) {
    await prisma.cluster.update({
      where: { id: clusterId },
      data: { config: { ...cfg, vault_slurmdbd_storage_pass: dbPass } as never },
    }).catch(() => {});
  }
  return "";
}

// ─── Inline controller-seed helper (v1-local) ────────────────────────────
// Mirrors the seedControllerAsNode function in /api/clusters/[id]/bootstrap.
// Kept here (rather than imported) so the v1 path doesn't depend on the UI
// route's task-logging plumbing. Returns a diagnostic string suitable for
// echoing to the caller — empty on success.
interface InlineSshTarget {
  host: string;
  user: string;
  port: number;
  privateKey: string;
  bastion: boolean;
  proxyCommand: string | null;
  jumpProxyCommand: string | null;
}
async function seedControllerInline(clusterId: string, sshTarget: InlineSshTarget): Promise<string> {
  if (!sshTarget.privateKey) return "no ssh key — skipped";
  const fresh = await prisma.cluster.findUnique({ where: { id: clusterId } });
  if (!fresh) return "cluster row vanished";
  const cfg = (fresh.config ?? {}) as Record<string, unknown>;
  const hosts = (cfg.slurm_hosts_entries ?? []) as Array<Record<string, unknown> & { hostname?: string }>;
  const nodes = (cfg.slurm_nodes ?? []) as Array<Record<string, unknown> & { expression?: string }>;
  // Don't early-return on a non-empty node list — re-bootstraps after a
  // controllerHost/sshPort change still need to refresh the controller's
  // host entry so the inventory points at the new endpoint. The upsert
  // below is keyed on hostname, so user-added workers aren't disturbed.

  const MARKER = `__SEED_${Date.now()}__`;
  const probe = `
echo "${MARKER}_START"
echo "hostname=$(hostname)"
echo "cpus=$(nproc --all)"
LSCPU=$(lscpu 2>/dev/null)
echo "sockets=$(echo "$LSCPU" | awk -F: '/^Socket\\(s\\):/ {gsub(/ /,"",$2); print $2}')"
echo "cores_per_socket=$(echo "$LSCPU" | awk -F: '/^Core\\(s\\) per socket:/ {gsub(/ /,"",$2); print $2}')"
echo "threads_per_core=$(echo "$LSCPU" | awk -F: '/^Thread\\(s\\) per core:/ {gsub(/ /,"",$2); print $2}')"
echo "memory_mb=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
echo "gpus=$(command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L 2>/dev/null | wc -l || echo 0)"
echo "${MARKER}_END"
`;
  const out: string[] = [];
  const err: string[] = [];
  let probeOk = false;
  await new Promise<void>((resolve) => {
    sshExecScript(sshTarget, probe, {
      onStream: (line) => {
        if (line.startsWith("[stderr]")) err.push(line.slice(9));
        else out.push(line);
      },
      onComplete: (ok) => { probeOk = ok; resolve(); },
    });
  });
  const blob = out.join("\n");
  const s = blob.indexOf(`${MARKER}_START`);
  const e = blob.indexOf(`${MARKER}_END`);
  if (s === -1 || e === -1) {
    return `probe failed (probeOk=${probeOk} stdout=${out.length} stderr=${err.length}); err tail: ${err.slice(-5).join(" | ")}`;
  }
  const body = blob.slice(s + MARKER.length + 6, e);
  const kv: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^([a-z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  const hostname = kv.hostname || sshTarget.host;
  const cpus = parseInt(kv.cpus, 10) || 1;
  const sockets = parseInt(kv.sockets, 10) || 1;
  const cores = parseInt(kv.cores_per_socket, 10) || cpus;
  const threads = parseInt(kv.threads_per_core, 10) || 1;
  const rawMemMb = parseInt(kv.memory_mb, 10) || 1024;
  const memMargin = Math.max(64, Math.min(256, Math.floor(rawMemMb * 0.01)));
  const memMb = Math.max(512, rawMemMb - memMargin);
  const gpus = parseInt(kv.gpus, 10) || 0;

  // Upsert by hostname so a follow-up bootstrap whose cluster row has had
  // its controllerHost / sshPort changed since the LAST bootstrap updates
  // the stored ip/port instead of leaving a stale entry behind. A stale
  // entry (e.g. ip="localhost" port=22 from when the cluster was first
  // pointed at a docker-bound endpoint) otherwise survives the rerun and
  // leaks into [slurm_workers] in the next bootstrap's ansible inventory.
  const hostsIdx = hosts.findIndex((h) => h.hostname === hostname);
  const hostRow = {
    hostname,
    ip: sshTarget.host,
    user: sshTarget.user,
    port: sshTarget.port,
    role: "controller",
  };
  if (hostsIdx >= 0) hosts[hostsIdx] = hostRow;
  else hosts.push(hostRow);

  const nodesIdx = nodes.findIndex((n) => n.expression === hostname);
  const nodeRow = {
    expression: hostname,
    ip: sshTarget.host,
    ssh_user: sshTarget.user,
    ssh_port: sshTarget.port,
    cpus, gpus, memory_mb: memMb,
    sockets, cores_per_socket: cores, threads_per_core: threads,
    role: "controller",
  };
  if (nodesIdx >= 0) nodes[nodesIdx] = nodeRow;
  else nodes.push(nodeRow);

  await prisma.cluster.update({
    where: { id: clusterId },
    data: { config: { ...cfg, slurm_hosts_entries: hosts, slurm_nodes: nodes } as never },
  });
  return `seeded ${hostname} (${cpus}C/${gpus}G/${memMb}MB)`;
}
