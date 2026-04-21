/**
 * One-way git export of Aura state.
 *
 * Dumps clusters, their settings (partitions/nodes/storage/packages/
 * environment/python/users), jobs, and ssh-key *metadata* (never the private
 * key) into a target git repo as YAML files, commits, and pushes.
 *
 * Shells out to the system `git` binary so we can support both HTTPS (with
 * an embedded PAT) and SSH (via GIT_SSH_COMMAND pointing at a deploy key).
 */

import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as yaml from "js-yaml";
import { prisma } from "./prisma";

export interface GitSyncConfig {
  enabled: boolean;
  repoUrl: string;           // e.g. git@github.com:org/aura-state.git or https://...
  branch: string;            // default "main"
  path: string;              // subfolder inside repo, default ""
  deployKey: string;         // SSH private key (for git@ URLs) or empty
  httpsToken: string;        // PAT for https:// URLs or empty
  authorName: string;
  authorEmail: string;
  /**
   * When true, includes SSH private keys AND raw S3/token/password fields
   * in the exported YAML so the repo is a full restore target. Only enable
   * this if your git host is trusted and the repo is private.
   */
  includeSecrets: boolean;
  /**
   * Optional cluster id allow-list. Empty (or omitted) means "all clusters".
   * Jobs, templates, provisioned-user rows, and per-cluster config folders
   * are filtered to this set; SSH keys + the global users index are always
   * exported because they can be referenced cross-cluster.
   */
  clusterIds?: string[];
  lastSyncAt?: string;
  lastSyncStatus?: "success" | "failed";
  lastSyncMessage?: string;
}

export const DEFAULT_CONFIG: GitSyncConfig = {
  enabled: false,
  repoUrl: "",
  branch: "main",
  path: "",
  deployKey: "",
  httpsToken: "",
  authorName: "SlurmUI Sync",
  authorEmail: "slurmui-sync@localhost",
  includeSecrets: false,
};

export async function loadConfig(): Promise<GitSyncConfig> {
  const row = await prisma.setting.findUnique({ where: { key: "git_sync_config" } });
  if (!row) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(cfg: GitSyncConfig): Promise<void> {
  await prisma.setting.upsert({
    where: { key: "git_sync_config" },
    create: { key: "git_sync_config", value: JSON.stringify(cfg) },
    update: { value: JSON.stringify(cfg) },
  });
}

// ───────────────────── YAML (minimal dumper, no deps) ──────────────────────
// Enough for our value types. We keep it small to avoid pulling a js-yaml dep.

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  // Multi-line → block scalar
  if (s.includes("\n")) {
    const lines = s.split("\n");
    return "|\n" + lines.map((l) => "  " + l).join("\n");
  }
  // Quote if it contains YAML-significant chars
  if (/^[^A-Za-z0-9_]|[:#\-*&!%@`'"{}\[\],]|^\s|\s$/.test(s) || /^(true|false|null|~|[0-9.-]+)$/i.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function yamlDump(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((v) => {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const inner = yamlDump(v, indent + 1);
        return `${pad}- ${inner.trimStart()}`;
      }
      return `${pad}- ${yamlScalar(v)}`;
    }).join("\n");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries.map(([k, v]) => {
      if (v !== null && typeof v === "object") {
        const inner = yamlDump(v, indent + 1);
        // Multi-line block scalars need to stay inline with the key.
        if (typeof inner === "string" && inner.startsWith("|")) {
          return `${pad}${k}: ${inner}`;
        }
        if (Array.isArray(v) && v.length === 0) return `${pad}${k}: []`;
        if (!Array.isArray(v) && Object.keys(v as object).length === 0) return `${pad}${k}: {}`;
        return `${pad}${k}:\n${inner}`;
      }
      return `${pad}${k}: ${yamlScalar(v)}`;
    }).join("\n");
  }
  return yamlScalar(value);
}

function writeYaml(path: string, value: unknown) {
  const dir = path.replace(/\/[^/]+$/, "");
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = `# Managed by SlurmUI git sync. Do not edit by hand.\n${yamlDump(value)}\n`;
  writeFileSync(path, out);
}

// ──────────────────────── git shell helper ─────────────────────────────────

interface GitOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLog: (line: string) => void;
}

function runGit(args: string[], opts: GitOpts): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    proc.stdout.on("data", (c: Buffer) => {
      const s = c.toString();
      stdout += s;
      for (const line of s.split("\n")) if (line.trim()) opts.onLog(line.trim());
    });
    proc.stderr.on("data", (c: Buffer) => {
      for (const line of c.toString().split("\n")) {
        if (line.trim()) opts.onLog(`[git] ${line.trim()}`);
      }
    });
    proc.on("close", (code) => resolve({ code, stdout }));
    proc.on("error", (err) => { opts.onLog(`[error] ${err.message}`); resolve({ code: -1, stdout }); });
  });
}

// ───────────────────────── sync orchestration ──────────────────────────────

/**
 * Collect every piece of state we want to track and return as an in-memory
 * file map: `relPath -> { value | rawString }`. Keeps the git layer dumb.
 */
async function collectState(includeSecrets: boolean, clusterIds?: string[]) {
  const files: Array<{ rel: string; content: string }> = [];

  // Clusters + child settings. An empty / missing allow-list = export all.
  const clusterFilter = clusterIds && clusterIds.length > 0
    ? { id: { in: clusterIds } }
    : undefined;
  const clusters = await prisma.cluster.findMany({
    where: clusterFilter,
    include: {
      sshKey: includeSecrets
        ? { select: { name: true, publicKey: true } }
        : { select: { name: true, publicKey: true } },
    },
  });
  const selectedIds = new Set(clusters.map((c) => c.id));
  const clustersIndex = clusters.map((c) => ({
    id: c.id,
    name: c.name,
    controllerHost: c.controllerHost,
    connectionMode: c.connectionMode,
    status: c.status,
    sshKey: c.sshKey?.name ?? null,
    createdAt: c.createdAt.toISOString(),
  }));
  files.push({ rel: "clusters/_index.yaml", content: toYamlFile(clustersIndex) });

  for (const c of clusters) {
    const config = (c.config ?? {}) as Record<string, any>;
    const safeConfig = includeSecrets ? config : redactSecrets(config);
    files.push({
      rel: `clusters/${c.name}/cluster.yaml`,
      content: toYamlFile({
        id: c.id,
        name: c.name,
        controllerHost: c.controllerHost,
        connectionMode: c.connectionMode,
        sshUser: c.sshUser,
        sshPort: c.sshPort,
        sshBastion: c.sshBastion,
        sshKey: c.sshKey?.name ?? null,
        status: c.status,
        createdAt: c.createdAt.toISOString(),
      }),
    });
    files.push({ rel: `clusters/${c.name}/config.yaml`, content: toYamlFile(safeConfig) });

    const partitions = (safeConfig.slurm_partitions ?? []) as unknown[];
    const nodes = (safeConfig.slurm_hosts_entries ?? []) as unknown[];
    const storage = (safeConfig.storage_mounts ?? []) as unknown[];
    const aptPkgs = (safeConfig.installed_packages ?? []) as unknown[];
    const pyPkgs = (safeConfig.python_packages ?? []) as unknown[];
    const env = (safeConfig.os_environment ?? []) as unknown[];

    files.push({ rel: `clusters/${c.name}/partitions.yaml`, content: toYamlFile(partitions) });
    files.push({ rel: `clusters/${c.name}/nodes.yaml`, content: toYamlFile(nodes) });
    files.push({ rel: `clusters/${c.name}/storage.yaml`, content: toYamlFile(storage) });
    files.push({ rel: `clusters/${c.name}/packages-apt.yaml`, content: toYamlFile(aptPkgs) });
    files.push({ rel: `clusters/${c.name}/packages-python.yaml`, content: toYamlFile(pyPkgs) });
    files.push({ rel: `clusters/${c.name}/environment.yaml`, content: toYamlFile(env) });

    // Provisioned users on this cluster
    const cus = await prisma.clusterUser.findMany({
      where: { clusterId: c.id },
      include: { user: { select: { email: true, name: true, unixUsername: true, unixUid: true } } },
    });
    files.push({
      rel: `clusters/${c.name}/users.yaml`,
      content: toYamlFile(cus.map((cu) => ({
        email: cu.user.email,
        name: cu.user.name,
        unixUsername: cu.user.unixUsername,
        unixUid: cu.user.unixUid,
        status: cu.status,
        provisionedAt: cu.provisionedAt?.toISOString() ?? null,
      }))),
    });
  }

  // Global users (all SlurmUI accounts, keyed by email). Needed so restore
  // can reattach jobs + cluster provisioning + templates to matching users.
  const allUsers = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      email: true, name: true, unixUsername: true, unixUid: true, unixGid: true,
      role: true, createdAt: true, keycloakId: true,
    },
  });
  files.push({
    rel: "users/_index.yaml",
    content: toYamlFile(allUsers.map((u) => ({
      email: u.email,
      name: u.name,
      role: u.role,
      unixUsername: u.unixUsername,
      unixUid: u.unixUid,
      unixGid: u.unixGid,
      keycloakId: u.keycloakId,
      createdAt: u.createdAt.toISOString(),
    }))),
  });

  // Per-user, per-cluster saved job templates — scoped to the allow-list
  // so a narrow export doesn't leak other clusters' templates.
  const templates = await prisma.jobTemplate.findMany({
    where: clusterFilter ? { clusterId: { in: [...selectedIds] } } : undefined,
    include: {
      cluster: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const tmplUserIds = Array.from(new Set(templates.map((t) => t.userId)));
  const tmplUsersById = new Map(
    (await prisma.user.findMany({
      where: { id: { in: tmplUserIds } },
      select: { id: true, email: true, unixUsername: true },
    })).map((u) => [u.id, u])
  );
  for (const t of templates) {
    const owner = tmplUsersById.get(t.userId);
    const ownerKey = owner?.email ?? owner?.unixUsername ?? t.userId;
    const safeName = t.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const safeOwner = ownerKey.replace(/[^A-Za-z0-9._@-]/g, "_");
    files.push({
      rel: `clusters/${t.cluster.name}/templates/${safeOwner}__${safeName}.yaml`,
      content: toYamlFile({
        name: t.name,
        owner: owner?.email ?? null,
        ownerUnixUsername: owner?.unixUsername ?? null,
        description: t.description,
        partition: t.partition,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        script: t.script,
      }),
    });
  }

  // SSH keys. Public always; private only when user opts into full export.
  const sshKeys = await prisma.sshKey.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { clusters: true } } },
  });
  files.push({
    rel: "ssh-keys/_index.yaml",
    content: toYamlFile(sshKeys.map((k) => ({
      name: k.name,
      publicKey: k.publicKey,
      createdAt: k.createdAt.toISOString(),
      clustersUsing: k._count.clusters,
    }))),
  });
  if (includeSecrets) {
    // Write each private key as a separate file so users can `cat` them on
    // restore. Prefix with _ so it sorts distinctly from the index.
    for (const k of sshKeys) {
      const safeName = k.name.replace(/[^A-Za-z0-9._-]/g, "_");
      files.push({
        rel: `ssh-keys/private/${safeName}.key`,
        content: `# SlurmUI-managed private key. chmod 600 before use.\n${k.privateKey.trimEnd()}\n`,
      });
      files.push({
        rel: `ssh-keys/private/${safeName}.pub`,
        content: `${k.publicKey.trimEnd()}\n`,
      });
    }
  }

  // Jobs: always include every PENDING/RUNNING job, plus the most recent 500
  // finished jobs for history. Active jobs must survive a migration regardless
  // of age, so we can't just rely on a recency cap.
  const jobClusterFilter = clusterFilter ? { clusterId: { in: [...selectedIds] } } : {};
  const [activeJobs, recentJobs] = await Promise.all([
    prisma.job.findMany({
      where: { status: { in: ["PENDING", "RUNNING"] }, ...jobClusterFilter },
      include: { cluster: { select: { name: true } } },
    }),
    prisma.job.findMany({
      where: { status: { in: ["COMPLETED", "FAILED", "CANCELLED"] }, ...jobClusterFilter },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { cluster: { select: { name: true } } },
    }),
  ]);
  const jobs = [...activeJobs, ...recentJobs];
  const userIds = Array.from(new Set(jobs.map((j) => j.userId)));
  const usersById = new Map(
    (await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, unixUsername: true },
    })).map((u) => [u.id, u])
  );
  for (const j of jobs) {
    const u = usersById.get(j.userId);
    files.push({
      rel: `jobs/${j.cluster.name}/${j.createdAt.toISOString().slice(0, 10)}/${j.id}.yaml`,
      content: toYamlFile({
        id: j.id,
        slurmJobId: j.slurmJobId,
        cluster: j.cluster.name,
        user: u?.unixUsername ?? u?.email ?? null,
        partition: j.partition,
        status: j.status,
        exitCode: j.exitCode,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
        script: j.script,
      }),
    });
  }

  // Top-level README so git clients show something helpful.
  files.push({
    rel: "README.md",
    content: "# SlurmUI state\n\nManaged by SlurmUI. One-way export of cluster definitions, settings, ssh-key metadata, and job history.\n\n**Do not edit by hand — changes are overwritten on the next sync.**\n",
  });

  return files;
}

function toYamlFile(v: unknown): string {
  return `# Managed by SlurmUI git sync. Do not edit by hand.\n${yamlDump(v)}\n`;
}

// Redact any key whose name hints at a secret (accessKey, secretKey, token,
// password, etc.). Mirrors lib/redact-config.ts but with a plain "(redacted)"
// marker since the git copy isn't round-tripped back into the DB.
function redactSecrets<T>(value: T): T {
  const HINTS = ["secretkey", "accesskey", "privatekey", "password", "passwd", "token", "credential"];
  const isSensitive = (k: string) => {
    const lower = k.toLowerCase();
    return HINTS.some((h) => lower.includes(h));
  };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (isSensitive(k) && typeof val === "string" && val.length > 0) out[k] = "(redacted)";
        else out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

// ───────────────────────── public sync entry point ──────────────────────────

/**
 * Run a sync. Calls `onLog` for every progress line. Returns true on success.
 * Throws on misconfiguration.
 */
export async function runSync(onLog: (line: string) => void): Promise<boolean> {
  const cfg = await loadConfig();
  if (!cfg.repoUrl) throw new Error("repoUrl is not set");

  const workDir = mkdtempSync(join(tmpdir(), "slurmui-git-"));
  let keyPath: string | null = null;
  let gitUrl = cfg.repoUrl;
  const env: NodeJS.ProcessEnv = { ...process.env };

  try {
    if (cfg.repoUrl.startsWith("http") && cfg.httpsToken) {
      // Embed PAT into URL: https://x-access-token:TOKEN@host/path
      const u = new URL(cfg.repoUrl);
      u.username = "x-access-token";
      u.password = cfg.httpsToken;
      gitUrl = u.toString();
    } else if (cfg.deployKey) {
      keyPath = join(workDir, "_deploy_key");
      writeFileSync(keyPath, cfg.deployKey.endsWith("\n") ? cfg.deployKey : cfg.deployKey + "\n", { mode: 0o600 });
      env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
    }

    const repoDir = join(workDir, "repo");
    const opts: GitOpts = { cwd: workDir, env, onLog };

    onLog(`[sync] Cloning ${cfg.repoUrl} (branch ${cfg.branch})...`);
    let clone = await runGit(["clone", "--depth", "1", "--branch", cfg.branch, gitUrl, "repo"], opts);
    if (clone.code !== 0) {
      // Branch may not exist yet — clone default then create.
      onLog(`[sync] Branch not found, cloning default and creating ${cfg.branch}...`);
      clone = await runGit(["clone", "--depth", "1", gitUrl, "repo"], opts);
      if (clone.code !== 0) throw new Error("git clone failed");
      await runGit(["checkout", "-B", cfg.branch], { ...opts, cwd: repoDir });
    }

    // Configure author in this repo.
    await runGit(["config", "user.name", cfg.authorName || "SlurmUI Sync"], { ...opts, cwd: repoDir });
    await runGit(["config", "user.email", cfg.authorEmail || "slurmui-sync@localhost"], { ...opts, cwd: repoDir });

    // Wipe the subtree we manage so deletions propagate. When a narrower
    // cluster allow-list is configured, only wipe the selected clusters'
    // folders — other clusters' previously-synced data stays in the repo.
    const targetBase = cfg.path ? join(repoDir, cfg.path) : repoDir;
    const narrow = cfg.clusterIds && cfg.clusterIds.length > 0;
    if (narrow) {
      // Translate ids → names so we can find the folders on disk.
      const selected = await prisma.cluster.findMany({
        where: { id: { in: cfg.clusterIds! } },
        select: { name: true },
      });
      for (const c of selected) {
        for (const sub of [`clusters/${c.name}`, `jobs/${c.name}`]) {
          const p = join(targetBase, sub);
          if (existsSync(p)) rmSync(p, { recursive: true, force: true });
        }
      }
      // Always refresh the global indices + ssh-keys.
      for (const f of ["ssh-keys", "users", "README.md", "clusters/_index.yaml"]) {
        const p = join(targetBase, f);
        if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      }
    } else {
      for (const sub of ["clusters", "ssh-keys", "jobs", "README.md"]) {
        const p = join(targetBase, sub);
        if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      }
    }

    if (cfg.includeSecrets) {
      onLog("[sync] includeSecrets=TRUE — exporting SSH private keys and raw config secrets.");
    } else {
      onLog("[sync] Secrets redacted. Enable includeSecrets to export a restorable snapshot.");
    }

    onLog("[sync] Collecting state from database...");
    const files = await collectState(cfg.includeSecrets, cfg.clusterIds);

    onLog(`[sync] Writing ${files.length} file(s)...`);
    for (const f of files) {
      writeYaml(join(targetBase, f.rel), null as any); // ensure dir
      writeFileSync(join(targetBase, f.rel), f.content);
    }

    await runGit(["add", "-A"], { ...opts, cwd: repoDir });
    const status = await runGit(["status", "--porcelain"], { ...opts, cwd: repoDir });
    if (!status.stdout.trim()) {
      onLog("[sync] No changes to commit.");
      return true;
    }

    const msg = `SlurmUI sync @ ${new Date().toISOString()}`;
    const commit = await runGit(["commit", "-m", msg], { ...opts, cwd: repoDir });
    if (commit.code !== 0) throw new Error("git commit failed");

    const push = await runGit(["push", "origin", cfg.branch], { ...opts, cwd: repoDir });
    if (push.code !== 0) throw new Error("git push failed (check deploy key / PAT permissions)");

    onLog("[sync] Pushed successfully.");

    // Stamp config with the outcome.
    await saveConfig({
      ...cfg,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: "success",
      lastSyncMessage: msg,
    });

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    onLog(`[error] ${message}`);
    await saveConfig({
      ...cfg,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: "failed",
      lastSyncMessage: message,
    });
    return false;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ───────────────────────── restore (import) ────────────────────────────────

export interface RestoreSummary {
  clustersCreated: number;
  clustersUpdated: number;
  clustersSkipped: string[]; // names with reasons
  sshKeysCreated: number;
  sshKeysUpdated: number;
  sshKeysSkipped: string[];
  usersCreated: number;
  usersUpdated: number;
  templatesCreated: number;
  templatesUpdated: number;
  templatesSkipped: string[];
  jobsRestored: number;
  warnings: string[];
}

function readYaml<T = unknown>(path: string): T | null {
  try {
    const text = readFileSync(path, "utf8");
    return yaml.load(text) as T;
  } catch {
    return null;
  }
}

function walkDirs(base: string): string[] {
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((n) => {
    try { return statSync(join(base, n)).isDirectory(); } catch { return false; }
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

/**
 * Pull current repo state and upsert it into the DB.
 * - Clusters keyed by `name` (portable across deployments).
 * - SSH keys keyed by `name`; private key only restored if the repo contains one.
 * - Templates keyed by (cluster, user-email-or-username, name).
 * - Jobs inserted with their original id if not already present (historical records).
 */
export async function runRestore(
  onLog: (line: string) => void,
  opts: { confirm: boolean } = { confirm: false },
): Promise<RestoreSummary> {
  if (!opts.confirm) throw new Error("confirm=true required");
  const cfg = await loadConfig();
  if (!cfg.repoUrl) throw new Error("repoUrl is not set");

  const workDir = mkdtempSync(join(tmpdir(), "slurmui-restore-"));
  let keyPath: string | null = null;
  let gitUrl = cfg.repoUrl;
  const env: NodeJS.ProcessEnv = { ...process.env };

  const summary: RestoreSummary = {
    clustersCreated: 0,
    clustersUpdated: 0,
    clustersSkipped: [],
    sshKeysCreated: 0,
    sshKeysUpdated: 0,
    sshKeysSkipped: [],
    usersCreated: 0,
    usersUpdated: 0,
    templatesCreated: 0,
    templatesUpdated: 0,
    templatesSkipped: [],
    jobsRestored: 0,
    warnings: [],
  };

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

    const repoDir = join(workDir, "repo");
    const opts2: GitOpts = { cwd: workDir, env, onLog };

    onLog(`[restore] Cloning ${cfg.repoUrl} (branch ${cfg.branch})...`);
    const clone = await runGit(["clone", "--depth", "1", "--branch", cfg.branch, gitUrl, "repo"], opts2);
    if (clone.code !== 0) throw new Error("git clone failed");

    const rootDir = cfg.path ? join(repoDir, cfg.path) : repoDir;

    // ── Users first: jobs, cluster provisioning, and templates all reference them.
    const usersYaml = readYaml<Array<{
      email: string; name?: string | null; role?: string;
      unixUsername?: string | null; unixUid?: number | null; unixGid?: number | null;
      keycloakId?: string | null;
    }>>(join(rootDir, "users", "_index.yaml")) ?? [];
    for (const u of usersYaml) {
      if (!u?.email) continue;
      const existing = await prisma.user.findUnique({ where: { email: u.email } });
      if (existing) {
        // Preserve the existing user's keycloakId (local auth mapping) unless
        // we have one and the DB row is empty.
        await prisma.user.update({
          where: { email: u.email },
          data: {
            name: u.name ?? existing.name,
            role: (u.role as any) ?? existing.role,
            unixUsername: u.unixUsername ?? existing.unixUsername,
            unixUid: u.unixUid ?? existing.unixUid,
            unixGid: u.unixGid ?? existing.unixGid,
          },
        });
        summary.usersUpdated++;
      } else {
        // New user row. keycloakId is unique — if the repo has one use it,
        // otherwise fall back to the email as a placeholder so the row is
        // still creatable (admin can rebind via Keycloak later).
        try {
          await prisma.user.create({
            data: {
              email: u.email,
              name: u.name ?? null,
              role: (u.role as any) ?? "USER",
              unixUsername: u.unixUsername ?? null,
              unixUid: u.unixUid ?? null,
              unixGid: u.unixGid ?? null,
              keycloakId: u.keycloakId ?? `import:${u.email}`,
            },
          });
          summary.usersCreated++;
          onLog(`[restore] created user ${u.email}`);
        } catch (e: any) {
          summary.warnings.push(`could not create user ${u.email}: ${e?.message ?? "unknown"}`);
        }
      }
    }

    // ── SSH keys, since clusters reference them by name ──
    const sshKeysIndex = readYaml<Array<{ name: string; publicKey: string }>>(
      join(rootDir, "ssh-keys", "_index.yaml")
    ) ?? [];
    const privateDir = join(rootDir, "ssh-keys", "private");
    for (const entry of sshKeysIndex) {
      if (!entry?.name) continue;
      const safeName = entry.name.replace(/[^A-Za-z0-9._-]/g, "_");
      const privPath = join(privateDir, `${safeName}.key`);
      let privateKey = "";
      if (existsSync(privPath)) {
        privateKey = readFileSync(privPath, "utf8").replace(/^# SlurmUI-managed private key\..*\n/, "");
      }

      if (!privateKey) {
        summary.sshKeysSkipped.push(`${entry.name} (no private key in repo — re-export with includeSecrets)`);
        onLog(`[restore] skip ssh key "${entry.name}" — no private key in repo`);
        continue;
      }

      const existing = await prisma.sshKey.findFirst({ where: { name: entry.name } });
      if (existing) {
        await prisma.sshKey.update({
          where: { id: existing.id },
          data: { publicKey: entry.publicKey, privateKey },
        });
        summary.sshKeysUpdated++;
        onLog(`[restore] updated ssh key "${entry.name}"`);
      } else {
        await prisma.sshKey.create({
          data: { name: entry.name, publicKey: entry.publicKey, privateKey },
        });
        summary.sshKeysCreated++;
        onLog(`[restore] created ssh key "${entry.name}"`);
      }
    }

    // ── Clusters ──
    const clustersBase = join(rootDir, "clusters");
    const clusterNames = walkDirs(clustersBase).filter((n) => !n.startsWith("_"));
    const sshKeyByName = new Map<string, { id: string }>();
    for (const k of await prisma.sshKey.findMany({ select: { id: true, name: true } })) {
      sshKeyByName.set(k.name, { id: k.id });
    }

    for (const name of clusterNames) {
      const dir = join(clustersBase, name);
      const meta = readYaml<{
        id?: string;
        name?: string;
        controllerHost?: string;
        connectionMode?: "NATS" | "SSH";
        sshUser?: string;
        sshPort?: number;
        sshBastion?: boolean;
        sshKey?: string | null;
        status?: string;
      }>(join(dir, "cluster.yaml"));
      const config = readYaml<Record<string, unknown>>(join(dir, "config.yaml")) ?? {};

      if (!meta?.name) {
        summary.clustersSkipped.push(`${name} (missing cluster.yaml)`);
        continue;
      }

      const sshKeyId = meta.sshKey ? sshKeyByName.get(meta.sshKey)?.id ?? null : null;
      if (meta.sshKey && !sshKeyId) {
        summary.warnings.push(`cluster "${meta.name}" references ssh key "${meta.sshKey}" which is not in the repo`);
      }

      const data = {
        name: meta.name,
        controllerHost: meta.controllerHost ?? "",
        connectionMode: meta.connectionMode ?? ("SSH" as any),
        sshUser: meta.sshUser ?? "root",
        sshPort: meta.sshPort ?? 22,
        sshBastion: meta.sshBastion ?? false,
        sshKeyId,
        config: config as any,
        // Imported clusters don't re-push to live nodes, so mark status INACTIVE
        // until the admin clicks Apply on each tab; if the repo recorded ACTIVE,
        // respect it and let Node status checks correct reality later.
        status: (meta.status ?? "PROVISIONING") as any,
      };

      const existing = await prisma.cluster.findUnique({ where: { name: meta.name } });
      let clusterId: string;
      if (existing) {
        await prisma.cluster.update({ where: { id: existing.id }, data });
        clusterId = existing.id;
        summary.clustersUpdated++;
        onLog(`[restore] updated cluster "${meta.name}"`);
      } else {
        const created = await prisma.cluster.create({ data: { ...data, natsCredentials: "" } });
        clusterId = created.id;
        summary.clustersCreated++;
        onLog(`[restore] created cluster "${meta.name}"`);
      }

      // Per-cluster provisioned users (ClusterUser rows) — link by email.
      const cuYaml = readYaml<Array<{
        email: string; status?: string; provisionedAt?: string | null;
      }>>(join(dir, "users.yaml")) ?? [];
      for (const cu of cuYaml) {
        if (!cu?.email) continue;
        const u = await prisma.user.findUnique({ where: { email: cu.email } });
        if (!u) {
          summary.warnings.push(`cluster "${meta.name}" provisioned user ${cu.email} not in users/_index.yaml`);
          continue;
        }
        await prisma.clusterUser.upsert({
          where: { userId_clusterId: { userId: u.id, clusterId } },
          create: {
            userId: u.id,
            clusterId,
            status: (cu.status as any) ?? "PENDING",
            provisionedAt: cu.provisionedAt ? new Date(cu.provisionedAt) : null,
          },
          update: {
            status: (cu.status as any) ?? "PENDING",
            provisionedAt: cu.provisionedAt ? new Date(cu.provisionedAt) : null,
          },
        });
      }

      // Per-cluster saved templates.
      const tplDir = join(dir, "templates");
      if (existsSync(tplDir)) {
        for (const f of readdirSync(tplDir)) {
          if (!f.endsWith(".yaml")) continue;
          const t = readYaml<{
            name?: string; owner?: string | null; ownerUnixUsername?: string | null;
            description?: string | null; partition?: string; script?: string;
          }>(join(tplDir, f));
          if (!t?.name || !t?.script || !t?.partition) {
            summary.templatesSkipped.push(`${meta.name}/${f} (incomplete)`);
            continue;
          }
          const ownerEmail = t.owner ?? "";
          const owner = ownerEmail ? await prisma.user.findUnique({ where: { email: ownerEmail } }) : null;
          if (!owner) {
            summary.templatesSkipped.push(`${meta.name}/${t.name} (owner ${ownerEmail || "unknown"} not in users)`);
            continue;
          }
          const existingTpl = await prisma.jobTemplate.findUnique({
            where: { clusterId_userId_name: { clusterId, userId: owner.id, name: t.name } },
          });
          if (existingTpl) {
            await prisma.jobTemplate.update({
              where: { id: existingTpl.id },
              data: {
                description: t.description ?? null,
                partition: t.partition,
                script: t.script,
              },
            });
            summary.templatesUpdated++;
          } else {
            await prisma.jobTemplate.create({
              data: {
                clusterId,
                userId: owner.id,
                name: t.name,
                description: t.description ?? null,
                partition: t.partition,
                script: t.script,
              },
            });
            summary.templatesCreated++;
          }
        }
      }
    }

    // ── Jobs (historical records) ──
    const jobsBase = join(rootDir, "jobs");
    if (existsSync(jobsBase)) {
      const clusterIdByName = new Map<string, string>();
      for (const c of await prisma.cluster.findMany({ select: { id: true, name: true } })) {
        clusterIdByName.set(c.name, c.id);
      }
      const userIdByKey = new Map<string, string>();
      for (const u of await prisma.user.findMany({ select: { id: true, email: true, unixUsername: true } })) {
        userIdByKey.set(u.email, u.id);
        if (u.unixUsername) userIdByKey.set(u.unixUsername, u.id);
      }
      for (const file of walkFiles(jobsBase)) {
        if (!file.endsWith(".yaml")) continue;
        const j = readYaml<{
          id?: string;
          slurmJobId?: number | null;
          cluster?: string;
          user?: string | null;
          partition?: string;
          status?: string;
          exitCode?: number | null;
          createdAt?: string;
          updatedAt?: string;
          script?: string;
        }>(file);
        if (!j?.id || !j?.cluster) continue;
        const existing = await prisma.job.findUnique({ where: { id: j.id } });
        if (existing) continue; // don't clobber live jobs
        const clusterId = clusterIdByName.get(j.cluster);
        if (!clusterId) continue;
        const userId = j.user ? userIdByKey.get(j.user) : undefined;
        if (!userId) continue; // can't attach job without a user
        try {
          await prisma.job.create({
            data: {
              id: j.id,
              clusterId,
              userId,
              slurmJobId: j.slurmJobId ?? null,
              script: j.script ?? "",
              partition: j.partition ?? "",
              status: (j.status ?? "COMPLETED") as any,
              exitCode: j.exitCode ?? null,
              createdAt: j.createdAt ? new Date(j.createdAt) : undefined,
            },
          });
          summary.jobsRestored++;
        } catch {
          // ignore — FK or unique violations just skip the row
        }
      }
    }

    onLog(`[restore] done: +${summary.clustersCreated}/~${summary.clustersUpdated} clusters, ` +
      `+${summary.sshKeysCreated}/~${summary.sshKeysUpdated} ssh keys, ` +
      `${summary.jobsRestored} jobs`);
    if (summary.warnings.length > 0) {
      onLog(`[restore] ${summary.warnings.length} warning(s):`);
      for (const w of summary.warnings) onLog(`  - ${w}`);
    }

    return summary;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
