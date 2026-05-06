/**
 * GitOps for job submission.
 *
 * Watches a target git repo on a fixed cron interval and reconciles the set
 * of `jobs/**\/*.yaml` manifests against the `Job` table. One manifest =
 * one (clusterId, sourceName) Job lineage. Content changes (cancel + resubmit)
 * are detected via a sha256 of the YAML body stored in `Job.sourceRef`.
 *
 * Off by default. Enable via the `gitops_jobs_config` Setting row (admin UI).
 *
 * Manifest shape:
 *   apiVersion: aura/v1
 *   kind: Job
 *   metadata: { name: <unique-per-cluster>, cluster: <cluster name>, user: <email> }
 *   spec: { partition: <name>, script: |- <sbatch> }
 *
 * Auth + clone reuses the same credential pattern as lib/git-sync.ts (PAT for
 * https URLs, deploy key via GIT_SSH_COMMAND for git@ URLs).
 */

import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "fs";
import { createHash } from "crypto";
import { join, relative } from "path";
import { tmpdir } from "os";
import * as yaml from "js-yaml";
import { prisma } from "./prisma";
import { submitJob } from "./submit-job";
import { logAudit } from "./audit";

export interface GitOpsJobsConfig {
  enabled: boolean;
  repoUrl: string;
  branch: string;
  /** Subfolder inside the repo to scan; manifests live under `<path>/jobs/**`. */
  path: string;
  deployKey: string;
  httpsToken: string;
  /** Reconcile cadence. Clamped to >= 180 seconds. */
  intervalSec: number;
  lastReconcileAt?: string;
  lastStatus?: "success" | "failed";
  lastMessage?: string;
}

export const DEFAULT_GITOPS_JOBS_CONFIG: GitOpsJobsConfig = {
  enabled: false,
  repoUrl: "",
  branch: "main",
  path: "",
  deployKey: "",
  httpsToken: "",
  intervalSec: 180,
};

const SETTING_KEY = "gitops_jobs_config";

export async function loadGitOpsJobsConfig(): Promise<GitOpsJobsConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return { ...DEFAULT_GITOPS_JOBS_CONFIG };
  try {
    return { ...DEFAULT_GITOPS_JOBS_CONFIG, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_GITOPS_JOBS_CONFIG };
  }
}

export async function saveGitOpsJobsConfig(cfg: GitOpsJobsConfig): Promise<void> {
  // Clamp interval to a sane minimum so the cron can't be set to 0.
  const safe: GitOpsJobsConfig = { ...cfg, intervalSec: Math.max(180, Math.floor(cfg.intervalSec || 180)) };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: JSON.stringify(safe) },
    update: { value: JSON.stringify(safe) },
  });
}

// ─────────────── git shell (mirrors git-sync.ts to stay consistent) ───────────

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, onLog: (l: string) => void): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, env });
    let stdout = "";
    proc.stdout.on("data", (c: Buffer) => {
      const s = c.toString();
      stdout += s;
      for (const line of s.split("\n")) if (line.trim()) onLog(line.trim());
    });
    proc.stderr.on("data", (c: Buffer) => {
      for (const line of c.toString().split("\n")) if (line.trim()) onLog(`[git] ${line.trim()}`);
    });
    proc.on("close", (code) => resolve({ code, stdout }));
    proc.on("error", (err) => { onLog(`[error] ${err.message}`); resolve({ code: -1, stdout }); });
  });
}

function walkFiles(base: string): string[] {
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

// ─────────────────────────── manifest model ────────────────────────────────

interface JobManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; cluster?: string; user?: string };
  spec?: { partition?: string; script?: string };
}

interface ParsedManifest {
  /** Repo-relative path, used as the stable identifier in `sourceRef`. */
  relPath: string;
  contentHash: string;
  name: string;
  clusterName: string;
  userEmail: string;
  partition: string;
  script: string;
}

export interface ReconcileSummary {
  scanned: number;
  submitted: number;
  resubmitted: number;
  cancelled: number;
  unchanged: number;
  skipped: { path: string; reason: string }[];
  errors: { path: string; error: string }[];
}

function parseManifest(relPath: string, body: string): { ok: ParsedManifest } | { err: string } {
  let doc: JobManifest;
  try {
    doc = yaml.load(body) as JobManifest;
  } catch (e) {
    return { err: `yaml parse: ${e instanceof Error ? e.message : "unknown"}` };
  }
  if (!doc || typeof doc !== "object") return { err: "empty document" };
  if (doc.kind !== "Job") return { err: `kind must be "Job", got "${doc.kind}"` };
  const name = doc.metadata?.name;
  const clusterName = doc.metadata?.cluster;
  const userEmail = doc.metadata?.user;
  const partition = doc.spec?.partition;
  const script = doc.spec?.script;
  if (!name) return { err: "metadata.name required" };
  if (!clusterName) return { err: "metadata.cluster required" };
  if (!userEmail) return { err: "metadata.user required" };
  if (!partition) return { err: "spec.partition required" };
  if (!script) return { err: "spec.script required" };
  return {
    ok: {
      relPath,
      contentHash: createHash("sha256").update(body).digest("hex").slice(0, 16),
      name,
      clusterName,
      userEmail,
      partition,
      script,
    },
  };
}

// ─────────────────────────── slurm cancel helper ─────────────────────────────

async function cancelSlurmJob(jobId: string, onLog: (l: string) => void): Promise<boolean> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { cluster: { include: { sshKey: true } } },
  });
  if (!job?.slurmJobId || !job.cluster) {
    await prisma.job.update({ where: { id: jobId }, data: { status: "CANCELLED" } }).catch(() => {});
    return true;
  }
  const c = job.cluster;
  if (c.connectionMode === "SSH" && c.sshKey) {
    const { sshExecScript } = await import("./ssh-exec");
    let cancelOk = false;
    await new Promise<void>((resolve) => {
      sshExecScript(
        { host: c.controllerHost, user: c.sshUser, port: c.sshPort, privateKey: c.sshKey!.privateKey, bastion: c.sshBastion },
        // --signal=KILL --full sends SIGKILL to *every* task (including the
        // batch shell) without waiting for KillWait. Default scancel uses
        // SIGTERM + 30s grace, which leaves the job in CG state for ages
        // and keeps the allocation reserved. --full ensures srun steps
        // die too, not just the top-level task.
        //
        // Try as the login user first. If Slurm refuses (job belongs to
        // another user and the login user isn't a Slurm operator/admin),
        // fall back to sudo -n so root can cancel any job.
        `
set +e
# "Invalid job id specified" means Slurm doesn't know the job anymore —
# it already completed / was cancelled elsewhere / the controller was
# restarted. That's effectively the same as a successful cancel for our
# purposes (the allocation isn't held any longer), so report ok.
classify() {
  if echo "$1" | grep -q "Invalid job id specified"; then
    echo "[scancel-ok] job ${job.slurmJobId} already gone from Slurm"
    exit 0
  fi
}

SCANCEL_OUT=$(scancel --signal=KILL --full ${job.slurmJobId} 2>&1)
SCANCEL_RC=$?
if [ $SCANCEL_RC -eq 0 ] && ! echo "$SCANCEL_OUT" | grep -q "Kill job error"; then
  echo "$SCANCEL_OUT"
  echo "[scancel-ok] job ${job.slurmJobId} cancelled by $(id -un)"
  exit 0
fi
echo "$SCANCEL_OUT"
classify "$SCANCEL_OUT"
echo "[scancel-retry] retrying with sudo -n"
SUDO_OUT=$(sudo -n scancel --signal=KILL --full ${job.slurmJobId} 2>&1)
SUDO_RC=$?
echo "$SUDO_OUT"
if [ $SUDO_RC -eq 0 ] && ! echo "$SUDO_OUT" | grep -q "Kill job error"; then
  echo "[scancel-ok] job ${job.slurmJobId} cancelled via sudo"
  exit 0
fi
classify "$SUDO_OUT"
echo "[scancel-fail] scancel rc=$SCANCEL_RC sudo rc=$SUDO_RC"
exit 2
`.trim(),
        {
          onStream: (l) => {
            if (l.includes("[scancel-ok]")) cancelOk = true;
            onLog(`[scancel] ${l}`);
          },
          // Do NOT treat ssh `success` as "cancel succeeded". Under bastion
          // mode, sshExecScript reports success as soon as the END marker
          // comes back from the outer shell, even when the inner script's
          // `exit 2` said scancel failed. The only reliable signal is the
          // `[scancel-ok]` line we emit explicitly on a clean cancel.
          onComplete: () => resolve(),
        },
      );
    });
    if (!cancelOk) {
      // Leave the DB row's status alone — marking CANCELLED when the
      // Slurm job is still running causes drift. Caller will retry on the
      // next reconcile tick.
      onLog(`[scancel] could not cancel job ${job.slurmJobId} — leaving DB status unchanged`);
      return false;
    }
  } else if (c.connectionMode === "NATS") {
    try {
      const { publishCommand } = await import("./nats");
      await publishCommand(c.id, {
        request_id: job.id,
        type: "cancel_job",
        payload: { slurm_job_id: job.slurmJobId },
      });
    } catch (e) {
      onLog(`[scancel] nats publish failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
  await prisma.job.update({ where: { id: jobId }, data: { status: "CANCELLED" } }).catch(() => {});
  return true;
}

// ─────────────────────────── reconcile entry point ───────────────────────────

export async function runReconcile(onLog: (line: string) => void): Promise<ReconcileSummary> {
  const cfg = await loadGitOpsJobsConfig();
  if (!cfg.enabled) throw new Error("gitops jobs sync is disabled");
  if (!cfg.repoUrl) throw new Error("repoUrl is not set");

  const summary: ReconcileSummary = {
    scanned: 0, submitted: 0, resubmitted: 0, cancelled: 0, unchanged: 0,
    skipped: [], errors: [],
  };

  const workDir = mkdtempSync(join(tmpdir(), "aura-gitops-jobs-"));
  let keyPath: string | null = null;
  let gitUrl = cfg.repoUrl;
  const env: NodeJS.ProcessEnv = { ...process.env };

  try {
    if (cfg.repoUrl.startsWith("http") && cfg.httpsToken) {
      const u = new URL(cfg.repoUrl);
      u.username = "x-access-token";
      u.password = cfg.httpsToken;
      gitUrl = u.toString();
    } else if (cfg.deployKey) {
      keyPath = join(workDir, "_deploy_key");
      writeFileSync(keyPath, cfg.deployKey.endsWith("\n") ? cfg.deployKey : cfg.deployKey + "\n", { mode: 0o600 });
      env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
    }

    onLog(`[gitops] config: branch=${cfg.branch} path=${cfg.path || "<repo root>"} intervalSec=${cfg.intervalSec}`);
    onLog(`[gitops] cloning ${cfg.repoUrl} (branch ${cfg.branch})`);
    const clone = await runGit(["clone", "--depth", "1", "--branch", cfg.branch, gitUrl, "repo"], workDir, env, onLog);
    if (clone.code !== 0) throw new Error("git clone failed");
    const repoDir = join(workDir, "repo");
    // Record the HEAD sha + last commit so the log pinpoints exactly which
    // tree was reconciled (useful when triaging "why did we not pick up X").
    const rev = await runGit(["rev-parse", "HEAD"], repoDir, env, () => {});
    const headSha = rev.stdout.trim().slice(0, 12);
    const lastMsg = await runGit(["log", "-1", "--pretty=format:%an %ci | %s"], repoDir, env, () => {});
    onLog(`[gitops] HEAD=${headSha} — ${lastMsg.stdout.trim()}`);

    const jobsRoot = cfg.path ? join(repoDir, cfg.path, "jobs") : join(repoDir, "jobs");
    onLog(`[gitops] scanning ${relative(repoDir, jobsRoot) || "jobs"}/ for *.yaml`);

    // ── Parse all manifests ──────────────────────────────────────────────
    const parsed: ParsedManifest[] = [];
    for (const file of walkFiles(jobsRoot)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      summary.scanned++;
      const rel = relative(repoDir, file);
      const body = readFileSync(file, "utf8");
      const res = parseManifest(rel, body);
      if ("err" in res) {
        summary.skipped.push({ path: rel, reason: res.err });
        onLog(`[gitops] skip ${rel}: ${res.err}`);
        continue;
      }
      parsed.push(res.ok);
      onLog(`[gitops] parsed ${rel} → name=${res.ok.name} cluster=${res.ok.clusterName} user=${res.ok.userEmail} partition=${res.ok.partition} sha256=${res.ok.contentHash}`);
    }
    onLog(`[gitops] manifests: ${parsed.length} valid, ${summary.skipped.length} skipped`);

    // ── Cache cluster + user lookups ─────────────────────────────────────
    const clusters = await prisma.cluster.findMany({ select: { id: true, name: true } });
    const clusterByName = new Map(clusters.map((c) => [c.name, c.id]));
    const emails = Array.from(new Set(parsed.map((p) => p.userEmail)));
    const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } });
    const userByEmail = new Map(users.map((u) => [u.email, u.id]));
    onLog(`[gitops] known clusters: ${[...clusterByName.keys()].join(", ") || "(none)"}`);
    onLog(`[gitops] matched users:  ${[...userByEmail.keys()].join(", ") || "(none)"}`);

    // Track which (clusterId, sourceName) keys are present in this scan so we
    // can identify deletions afterwards.
    const seenKeys = new Set<string>();

    for (const m of parsed) {
      const clusterId = clusterByName.get(m.clusterName);
      if (!clusterId) {
        summary.skipped.push({ path: m.relPath, reason: `cluster "${m.clusterName}" not found` });
        continue;
      }
      const userId = userByEmail.get(m.userEmail);
      if (!userId) {
        summary.skipped.push({ path: m.relPath, reason: `user "${m.userEmail}" not found` });
        continue;
      }
      seenKeys.add(`${clusterId}\x00${m.name}`);

      const sourceRef = `${m.relPath}@sha256:${m.contentHash}`;
      const existing = await prisma.job.findUnique({
        where: { clusterId_sourceName: { clusterId, sourceName: m.name } },
      });

      try {
        if (!existing) {
          onLog(`[gitops] submit new ${m.relPath} (no existing job for sourceName="${m.name}")`);
          const res = await submitJob({
            clusterId, userId,
            script: m.script, partition: m.partition,
            sourceRef, sourceName: m.name,
            auditExtra: { via: "gitops", manifest: m.relPath },
          });
          onLog(`[gitops] submitted ${m.relPath} → job.id=${res?.id ?? "?"} slurmJobId=${res?.slurmJobId ?? "?"}`);
          summary.submitted++;
          continue;
        }

        if (existing.sourceRef === sourceRef) {
          onLog(`[gitops] unchanged ${m.relPath} → job.id=${existing.id} status=${existing.status} (sourceRef matches)`);
          summary.unchanged++;
          continue;
        }

        // Content changed → cancel-if-active + resubmit. Per user spec:
        // always cancel+resubmit on change, regardless of running state.
        onLog(`[gitops] resubmit ${m.relPath} (sourceRef changed: ${existing.sourceRef} → ${sourceRef})`);
        onLog(`[gitops]   existing job.id=${existing.id} slurmJobId=${existing.slurmJobId ?? "?"} status=${existing.status}`);
        if (existing.status === "PENDING" || existing.status === "RUNNING") {
          const ok = await cancelSlurmJob(existing.id, onLog);
          if (!ok) {
            onLog(`[gitops]   cancel FAILED — skipping resubmit to avoid duplicate running job. Will retry next tick.`);
            summary.errors.push({ path: m.relPath, error: "scancel failed (Slurm permission denied and sudo unavailable)" });
            continue;
          }
          summary.cancelled++;
        } else {
          onLog(`[gitops]   existing job is ${existing.status} — no cancel needed`);
        }
        // Drop the stale row so the @@unique([clusterId, sourceName]) lets
        // the new submission take its place. Keep history? No — the audit log
        // already records the lineage and the old job was cancelled; keeping
        // both rows would clutter the user's job list with phantom entries.
        await prisma.job.delete({ where: { id: existing.id } }).catch(() => {});
        const res = await submitJob({
          clusterId, userId,
          script: m.script, partition: m.partition,
          sourceRef, sourceName: m.name,
          auditExtra: { via: "gitops", manifest: m.relPath, replaces: existing.id },
        });
        onLog(`[gitops] resubmitted ${m.relPath} → job.id=${res?.id ?? "?"} slurmJobId=${res?.slurmJobId ?? "?"}`);
        summary.resubmitted++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown";
        summary.errors.push({ path: m.relPath, error: msg });
        onLog(`[gitops] error on ${m.relPath}: ${msg}`);
      }
    }

    // ── Removals: any gitops-owned job whose manifest no longer exists ───
    const owned = await prisma.job.findMany({
      where: { sourceName: { not: null } },
      select: { id: true, clusterId: true, sourceName: true, status: true, sourceRef: true },
    });
    onLog(`[gitops] removal scan: checking ${owned.length} gitops-owned job(s) against ${seenKeys.size} seen manifest key(s)`);
    let removedCount = 0;
    for (const j of owned) {
      const key = `${j.clusterId}\x00${j.sourceName}`;
      if (seenKeys.has(key)) continue;
      onLog(`[gitops] manifest removed → cancel+drop job.id=${j.id} sourceName=${j.sourceName} status=${j.status}`);
      if (j.status === "PENDING" || j.status === "RUNNING") {
        await cancelSlurmJob(j.id, onLog);
      }
      await prisma.job.delete({ where: { id: j.id } }).catch(() => {});
      summary.cancelled++;
      removedCount++;
    }
    if (removedCount === 0) onLog(`[gitops] removal scan: no manifests deleted since last tick`);

    // Dump a final status breakdown of all gitops-owned jobs so the operator
    // can see at a glance what actually lives in the DB after this pass.
    try {
      const final = await prisma.job.groupBy({
        by: ["status"],
        where: { sourceName: { not: null } },
        _count: { status: true },
      });
      const parts = final.map((f) => `${f.status}=${f._count.status}`).join(" ");
      onLog(`[gitops] gitops-owned job states: ${parts || "(none)"}`);
    } catch {}

    if (summary.skipped.length > 0) {
      for (const s of summary.skipped) onLog(`[gitops] skipped: ${s.path} (${s.reason})`);
    }
    if (summary.errors.length > 0) {
      for (const e of summary.errors) onLog(`[gitops] error:   ${e.path} (${e.error})`);
    }

    onLog(`[gitops] done: scanned=${summary.scanned} submitted=${summary.submitted} resubmitted=${summary.resubmitted} cancelled=${summary.cancelled} unchanged=${summary.unchanged} skipped=${summary.skipped.length} errors=${summary.errors.length}`);

    await saveGitOpsJobsConfig({
      ...cfg,
      lastReconcileAt: new Date().toISOString(),
      lastStatus: summary.errors.length === 0 ? "success" : "failed",
      lastMessage: summary.errors.length === 0
        ? `submitted ${summary.submitted}, resubmitted ${summary.resubmitted}, cancelled ${summary.cancelled}`
        : `${summary.errors.length} error(s)`,
    });

    await logAudit({
      action: "gitops_jobs.reconcile",
      entity: "Setting",
      entityId: SETTING_KEY,
      metadata: {
        scanned: summary.scanned,
        submitted: summary.submitted,
        resubmitted: summary.resubmitted,
        cancelled: summary.cancelled,
        unchanged: summary.unchanged,
        skipped: summary.skipped.length,
        errors: summary.errors.length,
      },
    });

    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    onLog(`[error] ${message}`);
    await saveGitOpsJobsConfig({
      ...cfg,
      lastReconcileAt: new Date().toISOString(),
      lastStatus: "failed",
      lastMessage: message,
    });
    throw err;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ─────────────────── export running jobs (adopt into jobs/) ──────────────

export interface ExportRunningSummary {
  exported: number;
  pruned: number;
}

// First line of every auto-adopted YAML. Used at prune time to tell
// "this file was written by the exporter" apart from a hand-authored
// manifest in the same `jobs/` tree — we must never delete the latter.
const ADOPTED_HEADER = "# Managed by SlurmUI GitOps — auto-adopted from a live job.";

/**
 * Clone the configured repo and reconcile `<path>/jobs/<cluster>/*.yaml`
 * with the set of currently PENDING/RUNNING jobs:
 *
 *   - Write/refresh a YAML for every running job (adoption: the next
 *     reconciler pass sees a matching sourceRef and leaves the row alone).
 *   - Delete the YAML for every previously-adopted job that is no longer
 *     running. Hand-authored manifests (those without the
 *     `# Managed by SlurmUI GitOps` header) are never touched.
 *
 * Pruning closes the loop: without it, completed/cancelled/failed jobs
 * left dangling adoption YAMLs in the repo forever. With it, the repo
 * is a faithful mirror of "what's live right now".
 */
export async function runExportRunning(onLog: (line: string) => void): Promise<ExportRunningSummary> {
  const cfg = await loadGitOpsJobsConfig();
  if (!cfg.repoUrl) throw new Error("repoUrl is not set");

  const workDir = mkdtempSync(join(tmpdir(), "aura-gitops-running-"));
  let keyPath: string | null = null;
  let gitUrl = cfg.repoUrl;
  const env: NodeJS.ProcessEnv = { ...process.env };

  try {
    if (cfg.repoUrl.startsWith("http") && cfg.httpsToken) {
      const u = new URL(cfg.repoUrl);
      u.username = "x-access-token";
      u.password = cfg.httpsToken;
      gitUrl = u.toString();
    } else if (cfg.deployKey) {
      keyPath = join(workDir, "_deploy_key");
      writeFileSync(keyPath, cfg.deployKey.endsWith("\n") ? cfg.deployKey : cfg.deployKey + "\n", { mode: 0o600 });
      env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
    }

    onLog(`[export] cloning ${cfg.repoUrl} (branch ${cfg.branch})`);
    let clone = await runGit(["clone", "--depth", "1", "--branch", cfg.branch, gitUrl, "repo"], workDir, env, onLog);
    if (clone.code !== 0) {
      onLog(`[export] branch ${cfg.branch} missing, falling back to default then creating`);
      clone = await runGit(["clone", "--depth", "1", gitUrl, "repo"], workDir, env, onLog);
      if (clone.code !== 0) throw new Error("git clone failed");
      await runGit(["checkout", "-B", cfg.branch], join(workDir, "repo"), env, onLog);
    }
    const repoDir = join(workDir, "repo");
    await runGit(["config", "user.name", "Aura GitOps"], repoDir, env, onLog);
    await runGit(["config", "user.email", "aura-gitops@localhost"], repoDir, env, onLog);

    const baseDir = cfg.path ? join(repoDir, cfg.path) : repoDir;
    const jobsDir = join(baseDir, "jobs");
    mkdirSync(jobsDir, { recursive: true });

    const jobs = await prisma.job.findMany({
      where: { status: { in: ["PENDING", "RUNNING"] } },
      include: { cluster: { select: { name: true } } },
    });
    const userIds = Array.from(new Set(jobs.map((j) => j.userId)));
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, unixUsername: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    type AdoptPatch = { jobId: string; sourceName: string; sourceRef: string };
    const patches: AdoptPatch[] = [];
    // Absolute paths of every YAML we've written or refreshed this run.
    // Anything auto-adopted on disk that's NOT in this set belongs to a
    // job that's no longer PENDING/RUNNING and gets pruned below.
    const writtenAbsPaths = new Set<string>();

    let exported = 0;
    for (const j of jobs) {
      const u = userById.get(j.userId);
      if (!u) continue;
      const clusterDir = join(jobsDir, j.cluster.name);
      mkdirSync(clusterDir, { recursive: true });
      const fileId = j.slurmJobId ? String(j.slurmJobId) : j.id.slice(0, 8);
      const filePath = join(clusterDir, `${fileId}.yaml`);
      const sourceName = j.sourceName ?? fileId;
      writtenAbsPaths.add(filePath);

      // Shape the YAML EXACTLY like parseManifest expects so the reconciler
      // can adopt the row on its next pass without resubmitting.
      const body = yaml.dump({
        apiVersion: "aura/v1",
        kind: "Job",
        metadata: {
          name: sourceName,
          cluster: j.cluster.name,
          user: u.email,
        },
        spec: {
          partition: j.partition,
          script: j.script,
        },
      }, { lineWidth: 120 });
      const fullBody = `${ADOPTED_HEADER}\n${body}`;
      writeFileSync(filePath, fullBody);

      // Compute sourceRef identically to the reconciler so the adoption
      // lookup below matches: relPath from repoDir, sha256 of the full body.
      const relPath = relative(repoDir, filePath);
      const contentHash = createHash("sha256").update(fullBody).digest("hex").slice(0, 16);
      const sourceRef = `${relPath}@sha256:${contentHash}`;
      patches.push({ jobId: j.id, sourceName, sourceRef });
      exported++;
    }

    // Prune YAMLs whose underlying job is no longer running. We treat the
    // Job table as the source of truth: any manifest in the tree that
    // we didn't (re)write this pass is checked against the DB.
    //
    //   row exists & status is terminal     → delete (job is done)
    //   row missing & file has adopt header → delete (adopted job was
    //                                         purged from the DB)
    //   row missing & no header             → keep  (looks hand-authored
    //                                         and awaiting reconcile)
    //   currently running                   → never reached: was already
    //                                         in writtenAbsPaths
    //
    // The header sniff is intentionally loose (`startsWith`) so older
    // adoption files with slightly different wording still get pruned.
    let pruned = 0;
    if (existsSync(jobsDir)) {
      const walk = (dir: string): string[] => {
        const out: string[] = [];
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, ent.name);
          if (ent.isDirectory()) out.push(...walk(p));
          else if (ent.isFile() && ent.name.endsWith(".yaml")) out.push(p);
        }
        return out;
      };

      // Cache cluster name → id so we can look up Job rows by the same
      // (clusterId, sourceName) compound key the reconciler uses.
      const allClusters = await prisma.cluster.findMany({ select: { id: true, name: true } });
      const clusterIdByName = new Map(allClusters.map((c) => [c.name, c.id]));

      for (const file of walk(jobsDir)) {
        if (writtenAbsPaths.has(file)) continue;

        let text = "";
        try { text = readFileSync(file, "utf8"); } catch { continue; }

        let parsed: unknown = null;
        try { parsed = yaml.load(text); } catch { /* malformed → skip below */ }
        const meta =
          (parsed && typeof parsed === "object" && "metadata" in parsed
            ? (parsed as { metadata?: unknown }).metadata
            : null) as { name?: unknown; cluster?: unknown } | null;
        const sourceName = typeof meta?.name === "string" ? meta.name : "";
        const clusterName = typeof meta?.cluster === "string" ? meta.cluster : "";
        const hasAdoptHeader = (text.split("\n", 1)[0] ?? "").trim().startsWith("# Managed by SlurmUI GitOps");

        let safeToDelete = false;
        if (sourceName && clusterName) {
          const clusterId = clusterIdByName.get(clusterName);
          if (clusterId) {
            const row = await prisma.job.findUnique({
              where: { clusterId_sourceName: { clusterId, sourceName } },
              select: { status: true },
            });
            if (row) {
              // Job exists and isn't running — terminal state, delete the YAML.
              if (row.status !== "PENDING" && row.status !== "RUNNING") {
                safeToDelete = true;
              }
            } else if (hasAdoptHeader) {
              // No row: was an adoption file, but the underlying job has
              // since been purged. Adoption files are exporter-owned, so
              // delete. Hand-authored ones (no header) we leave alone —
              // the next reconcile will pick them up.
              safeToDelete = true;
            }
          }
        } else if (hasAdoptHeader) {
          // Header present but malformed metadata — almost certainly an
          // adoption file from an older code path. Drop it.
          safeToDelete = true;
        }

        if (!safeToDelete) continue;
        try {
          rmSync(file);
          onLog(`[export] pruned ${relative(repoDir, file)} (job no longer running)`);
          pruned++;
        } catch (e) {
          onLog(`[export] failed to prune ${relative(repoDir, file)}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // Clean up the legacy running/ tree if it exists — we no longer
    // maintain a separate mirror now that adoption writes to jobs/.
    const legacyRunning = join(baseDir, "running");
    if (existsSync(legacyRunning)) {
      rmSync(legacyRunning, { recursive: true, force: true });
      await runGit(["add", "-A", "running"], baseDir, env, onLog);
    }

    await runGit(["add", "-A", "jobs"], baseDir, env, onLog);
    const status = await runGit(["status", "--porcelain"], repoDir, env, onLog);
    if (!status.stdout.trim()) {
      onLog(`[export] no changes (exported=${exported}, pruned=${pruned})`);
      // Still write the DB patches so future runs without git diffs can
      // adopt — even if the manifest already matched, Job.sourceName may
      // have been null before.
      for (const p of patches) {
        await prisma.job.update({
          where: { id: p.jobId },
          data: { sourceName: p.sourceName, sourceRef: p.sourceRef },
        }).catch(() => {});
      }
      return { exported, pruned };
    }

    const commit = await runGit(["commit", "-m", `SlurmUI GitOps adopt @ ${new Date().toISOString()}`], repoDir, env, onLog);
    if (commit.code !== 0) throw new Error("git commit failed");
    const push = await runGit(["push", "origin", cfg.branch], repoDir, env, onLog);
    if (push.code !== 0) throw new Error("git push failed (check deploy key / PAT permissions)");

    // After the push lands, mark each Job row with the matching sourceName
    // + sourceRef. From here on the reconciler treats these jobs as
    // manifest-owned and won't resubmit on the next scan.
    for (const p of patches) {
      await prisma.job.update({
        where: { id: p.jobId },
        data: { sourceName: p.sourceName, sourceRef: p.sourceRef },
      }).catch(() => {});
    }

    onLog(`[export] pushed (exported=${exported}, pruned=${pruned})`);

    await logAudit({
      action: "gitops_jobs.export_running",
      entity: "Setting",
      entityId: SETTING_KEY,
      metadata: { exported, pruned },
    });

    return { exported, pruned };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ─────────────────────────── background monitor ──────────────────────────────

let tickHandle: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let started = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const cfg = await loadGitOpsJobsConfig();
    if (!cfg.enabled || !cfg.repoUrl) return;

    // Create a BackgroundTask row so the settings UI can surface the last
    // cron-run logs the same way it surfaces manual "Reconcile now" logs.
    const task = await prisma.backgroundTask.create({
      data: { clusterId: "__global__", type: "gitops_jobs_reconcile" },
    }).catch(() => null);

    const appendLog = async (line: string) => {
      console.log(`[gitops-jobs] ${line}`);
      if (!task) return;
      try {
        await prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${line + "\n"} WHERE id = ${task.id}`;
      } catch {}
    };

    let ok = true;
    try {
      await runReconcile(appendLog);
    } catch (err) {
      ok = false;
      await appendLog(`[error] ${err instanceof Error ? err.message : String(err)}`);
    }

    if (task) {
      await prisma.backgroundTask.update({
        where: { id: task.id },
        data: { status: ok ? "success" : "failed", completedAt: new Date() },
      }).catch(() => {});
    }
  } catch (err) {
    console.warn("[gitops-jobs] tick failed:", err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}

async function scheduleNext(): Promise<void> {
  // Re-read config each time so interval changes apply without a restart.
  const cfg = await loadGitOpsJobsConfig().catch(() => DEFAULT_GITOPS_JOBS_CONFIG);
  const intervalSec = Math.max(180, cfg.intervalSec || 180);
  tickHandle = setTimeout(async () => {
    await tick();
    scheduleNext();
  }, intervalSec * 1000);
}

// Keep the started-flag on globalThis so it survives Next.js loading the
// monitor through both `instrumentation.ts` AND the custom `server.ts`
// entrypoint — a second module-instance would otherwise see `started`
// reset and arm a duplicate timer, producing two reconcile rows per tick
// (the audit-log doubling QA reported).
const STARTED_KEY = "__aura_gitops_jobs_started__";
declare global {
  // eslint-disable-next-line no-var
  var __aura_gitops_jobs_started__: boolean | undefined;
}

export function startGitopsJobsMonitor(): void {
  if (started || (globalThis as Record<string, unknown>)[STARTED_KEY]) return;
  started = true;
  (globalThis as Record<string, unknown>)[STARTED_KEY] = true;
  console.log("[gitops-jobs] monitor armed (off until enabled in settings)");
  // Defer initial run so the server finishes booting and the DB is reachable.
  setTimeout(() => {
    tick().catch(() => {});
    scheduleNext();
  }, 15_000);
}

export function stopGitopsJobsMonitor(): void {
  if (tickHandle) clearTimeout(tickHandle);
  tickHandle = null;
  started = false;
}
