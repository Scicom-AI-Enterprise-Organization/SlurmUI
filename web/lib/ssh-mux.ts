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

const cache = new Map<string, MuxEntry>();
const TTL_MS = parseInt(process.env.AURA_SSH_MUX_TTL_MS ?? "600000", 10);
// Must be <= TTL so the master exits before we forget about it, but large
// enough that a steady polling cadence (e.g. every 5s) never causes it to
// reopen. 10 minutes matches the default TTL.
const PERSIST_SEC = parseInt(process.env.AURA_SSH_MUX_PERSIST_SEC ?? "600", 10);

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

/**
 * Return a cached mux entry for this target, creating one on first use.
 * Callers must pass the returned `keyPath` as `-i` and `muxArgs(entry)` as
 * extra ssh options. Safe to call concurrently — the first caller wins the
 * cache slot; the second resolves to the same entry.
 */
export function getMux(target: MuxTarget): MuxEntry {
  const key = targetKey(target);
  let e = cache.get(key);
  if (e) {
    e.lastUsed = Date.now();
    return e;
  }
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
  // the socket filename short and colocated in our tmpDir (typically 40 chars).
  const socketPath = join(tmpDir, "s");
  e = { tmpDir, keyPath, jumpKeyPath, socketPath, lastUsed: Date.now() };
  cache.set(key, e);
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
 * Close and forget any mux entry for this target. Called on explicit teardown
 * (e.g. cluster key rotation). In steady state we rely on the TTL sweep +
 * OpenSSH's ControlPersist timer to clean up without manual intervention.
 */
export function dropMux(target: MuxTarget): void {
  const key = targetKey(target);
  const e = cache.get(key);
  if (!e) return;
  cache.delete(key);
  teardownEntry(e);
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

// Idle sweep. Runs every minute to evict entries idle beyond TTL.
if (muxEnabled()) {
  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of cache) {
      if (now - e.lastUsed > TTL_MS) {
        cache.delete(k);
        teardownEntry(e);
      }
    }
  }, 60_000).unref?.();
}
