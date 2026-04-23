/**
 * SSH connection multiplexing (ControlMaster).
 *
 * Rationale: every sshExec{,Script,Simple} spawns a fresh ssh process and
 * therefore a fresh TCP + TLS + SSH handshake — which with a ProxyJump or
 * bastion front-door easily runs 2–5s per call. For polled endpoints like
 * /jobs/:id/output the handshake dominates the wall clock.
 *
 * This module maintains a per-target cache of:
 *   - a persistent tmpDir that lives across calls (key + jump key + socket),
 *   - a ControlPath unix socket that OpenSSH uses to reuse an existing SSH
 *     connection via `-o ControlMaster=auto`.
 *
 * First ssh call to a given target opens the master. Subsequent calls (within
 * ControlPersist) piggyback on it and skip the handshake. Cache entries are
 * evicted after AURA_SSH_MUX_TTL_MS of idleness (default 10 min) — the
 * master exits on its own shortly after via ControlPersist.
 *
 * Gated behind AURA_SSH_MUX=1. When off, ssh-exec.ts uses the original
 * per-call tmpDir + key path. Opt-in so we can ship without risking the
 * battle-tested bastion path.
 */

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawn } from "child_process";

export interface MuxTarget {
  host: string;
  user: string;
  port: number;
  privateKey: string;
  jumpHost?: string | null;
  jumpUser?: string | null;
  jumpPort?: number | null;
  jumpPrivateKey?: string | null;
  proxyCommand?: string | null;
  jumpProxyCommand?: string | null;
}

interface MuxEntry {
  tmpDir: string;
  keyPath: string;
  jumpKeyPath: string | null;
  socketPath: string;
  lastUsed: number;
}

export function muxEnabled(): boolean {
  return process.env.AURA_SSH_MUX === "1";
}

interface MuxPool {
  entries: MuxEntry[];
  cursor: number;
  lastUsed: number;
}

const pools = new Map<string, MuxPool>();
const TTL_MS = parseInt(process.env.AURA_SSH_MUX_TTL_MS ?? "600000", 10);
// Must be <= TTL so the master exits before we forget about it, but large
// enough that a steady polling cadence (e.g. every 5s) never causes it to
// reopen. 10 minutes matches the default TTL.
const PERSIST_SEC = parseInt(process.env.AURA_SSH_MUX_PERSIST_SEC ?? "600", 10);
const POOL_SIZE = Math.max(1, parseInt(process.env.AURA_SSH_MUX_POOL_SIZE ?? "1", 10));

function targetKey(t: MuxTarget): string {
  const parts = [
    t.host, t.port, t.user,
    t.jumpHost ?? "", t.jumpPort ?? "", t.jumpUser ?? "",
    t.proxyCommand ?? "", t.jumpProxyCommand ?? "",
    // include the key so rotations don't silently reuse the old socket
    createHash("sha1").update(t.privateKey).digest("hex"),
    t.jumpPrivateKey ? createHash("sha1").update(t.jumpPrivateKey).digest("hex") : "",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 20);
}

function createEntry(target: MuxTarget, slot: number): MuxEntry {
  const tmpDir = mkdtempSync(join(tmpdir(), "aura-sshmux-"));
  const keyPath = join(tmpDir, "ssh_key");
  writeFileSync(keyPath, target.privateKey, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  let jumpKeyPath: string | null = null;
  if (target.jumpPrivateKey && target.jumpPrivateKey !== target.privateKey) {
    jumpKeyPath = join(tmpDir, "ssh_jump_key");
    writeFileSync(jumpKeyPath, target.jumpPrivateKey, { mode: 0o600 });
    chmodSync(jumpKeyPath, 0o600);
  }
  // Unix domain sockets have a path-length limit of ~108 bytes on Linux. Keep
  // the socket filename short and colocated in our tmpDir. The slot suffix
  // ensures each pool entry has a distinct ControlPath — otherwise the
  // second entry's spawn would just reuse the first master and we'd gain
  // nothing from the pool.
  const socketPath = join(tmpDir, `s${slot}`);
  return { tmpDir, keyPath, jumpKeyPath, socketPath, lastUsed: Date.now() };
}

/**
 * Return a pooled mux entry for this target. The pool round-robins across
 * up to AURA_SSH_MUX_POOL_SIZE entries per target (lazily created), each
 * backed by its own ControlMaster master connection.
 *
 * For ControlMaster alone, one master already handles many concurrent
 * channels (sshd's MaxSessions, default 10). A pool buys you:
 *   - headroom past MaxSessions for high-concurrency targets, and
 *   - isolation — one wedged master doesn't stall every in-flight call.
 */
export function getMux(target: MuxTarget): MuxEntry {
  const key = targetKey(target);
  let pool = pools.get(key);
  if (!pool) {
    pool = { entries: [], cursor: 0, lastUsed: Date.now() };
    pools.set(key, pool);
  }
  // Lazy-grow up to POOL_SIZE. Once at cap, round-robin through existing.
  if (pool.entries.length < POOL_SIZE) {
    const e = createEntry(target, pool.entries.length);
    pool.entries.push(e);
    pool.cursor = pool.entries.length - 1;
    pool.lastUsed = Date.now();
    return e;
  }
  const e = pool.entries[pool.cursor % pool.entries.length];
  pool.cursor = (pool.cursor + 1) % pool.entries.length;
  e.lastUsed = Date.now();
  pool.lastUsed = Date.now();
  return e;
}

/** ssh -o flags enabling ControlMaster on this entry. */
export function muxArgs(entry: MuxEntry): string[] {
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${entry.socketPath}`,
    "-o", `ControlPersist=${PERSIST_SEC}`,
  ];
}

/**
 * Close and forget any mux entries for this target. Called on explicit
 * teardown (e.g. cluster key rotation). In steady state we rely on the TTL
 * sweep + OpenSSH's ControlPersist timer to clean up without manual
 * intervention.
 */
export function dropMux(target: MuxTarget): void {
  const key = targetKey(target);
  const pool = pools.get(key);
  if (!pool) return;
  pools.delete(key);
  for (const e of pool.entries) teardownEntry(e);
}

function teardownEntry(e: MuxEntry) {
  // Best-effort: ask the master to exit (ControlPath -O exit). Swallow errors
  // — if the master is already gone the tmpDir cleanup below is sufficient.
  try {
    const p = spawn("ssh", ["-O", "exit", "-o", `ControlPath=${e.socketPath}`, "_"], {
      stdio: "ignore",
    });
    p.on("error", () => {});
    setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 2000);
  } catch {}
  try { rmSync(e.tmpDir, { recursive: true, force: true }); } catch {}
}

// Idle sweep. Runs every minute; when every entry in a pool has been idle
// past TTL, tears them all down and drops the pool.
if (muxEnabled()) {
  setInterval(() => {
    const now = Date.now();
    for (const [k, pool] of pools) {
      const allIdle = pool.entries.every((e) => now - e.lastUsed > TTL_MS);
      if (allIdle && now - pool.lastUsed > TTL_MS) {
        pools.delete(k);
        for (const e of pool.entries) teardownEntry(e);
      }
    }
  }, 60_000).unref?.();
}
