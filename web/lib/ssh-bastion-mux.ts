/**
 * Long-lived bastion shell with reusable command framing.
 *
 * The default bastion path in ssh-exec.ts pays the following per call:
 *   - fresh SSH handshake (often via jumphost) — 2–5s
 *   - 1.5s setTimeout bootstrap delay before writing any command
 *   - stdin throttling of ~25 KB/s to dodge PTY byte-drops
 *   - END marker / idle-kill wait to confirm completion
 *
 * For polled endpoints (the /output poll every 5s) the handshake + bootstrap
 * dominate the wall clock and we do them over and over despite the shell
 * having been perfectly usable a few seconds ago.
 *
 * This module keeps ONE `ssh -tt user@bastion` process alive per target and
 * lets callers enqueue scripts. Each script is wrapped in unique START/END
 * markers; the session parses the shared stdout stream to dispatch output
 * lines back to the originating call and to read the exit code. Commands
 * are serialised per session (single shell, single execution at a time).
 *
 * Gated by AURA_BASTION_MUX=1. When off, ssh-exec.ts uses the original
 * per-call bastion path.
 *
 * Lifecycle:
 *   - First enqueue on a target spawns the shell and runs a one-time warm-up
 *     (stty, PS1='' , a synthetic ready marker).
 *   - Subsequent enqueues reuse the open shell.
 *   - On close / error, the session is flagged dead, any in-flight callers
 *     get onComplete(success=false), queued callers are re-dispatched on the
 *     next session (they're not lost).
 *   - Idle TTL evicts the session after AURA_BASTION_MUX_TTL_MS; OpenSSH's
 *     ServerAliveInterval keeps the TCP connection healthy in the meantime.
 */

import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash, randomBytes } from "crypto";

export interface BastionTarget {
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

export interface BastionExecRequest {
  script: string;
  onStream: (line: string) => void;
  onComplete: (success: boolean, exitCode: number | null, error?: string) => void;
}

export function bastionMuxEnabled(): boolean {
  return process.env.AURA_BASTION_MUX === "1";
}

const TTL_MS = parseInt(process.env.AURA_BASTION_MUX_TTL_MS ?? "600000", 10);
const READY_TIMEOUT_MS = parseInt(process.env.AURA_BASTION_MUX_READY_MS ?? "30000", 10);
const EXEC_TIMEOUT_MS = parseInt(process.env.AURA_BASTION_MUX_EXEC_MS ?? "600000", 10);
const POOL_SIZE = Math.max(1, parseInt(process.env.AURA_BASTION_MUX_POOL_SIZE ?? "5", 10));

function targetKey(t: BastionTarget): string {
  const parts = [
    t.host, t.port, t.user,
    t.jumpHost ?? "", t.jumpPort ?? "", t.jumpUser ?? "",
    t.proxyCommand ?? "", t.jumpProxyCommand ?? "",
    createHash("sha1").update(t.privateKey).digest("hex"),
    t.jumpPrivateKey ? createHash("sha1").update(t.jumpPrivateKey).digest("hex") : "",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 20);
}

const READY_MARKER = "__AURA_BASTION_READY__";

class BastionSession {
  private proc: ChildProcess;
  private tmpDir: string;
  private buffer = "";
  private warmed = false;
  private warmupWaiters: Array<(ok: boolean) => void> = [];
  private queue: BastionExecRequest[] = [];
  private current: BastionExecRequest | null = null;
  private currentId = "";
  private currentInside = false;
  private currentLines: string[] = [];
  private currentTimer: NodeJS.Timeout | null = null;
  private dead = false;
  lastUsed = Date.now();

  constructor(private target: BastionTarget) {
    this.tmpDir = mkdtempSync(join(tmpdir(), "aura-bmux-"));
    const keyPath = join(this.tmpDir, "ssh_key");
    writeFileSync(keyPath, target.privateKey, { mode: 0o600 });
    chmodSync(keyPath, 0o600);

    let jumpKeyPath = keyPath;
    if (target.jumpPrivateKey && target.jumpPrivateKey !== target.privateKey) {
      jumpKeyPath = join(this.tmpDir, "ssh_jump_key");
      writeFileSync(jumpKeyPath, target.jumpPrivateKey, { mode: 0o600 });
      chmodSync(jumpKeyPath, 0o600);
    }

    const args = [
      "-i", keyPath,
      "-p", String(target.port),
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=15",
      // Keep the TCP connection healthy across idle periods so the session
      // survives long gaps between polls without the peer or a middlebox
      // silently dropping it.
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-tt",
    ];
    // Build ProxyCommand inline (mirrors buildJumpArgs in ssh-exec.ts).
    const hostProxy = target.proxyCommand?.trim() || "";
    const jumpProxy = target.jumpProxyCommand?.trim() || "";
    if (hostProxy) {
      args.push("-o", `ProxyCommand=${hostProxy}`);
    } else if (target.jumpHost) {
      const u = target.jumpUser || "root";
      const p = target.jumpPort || 22;
      const jumpOpts = `-i ${jumpKeyPath} -p ${p} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o LogLevel=ERROR`;
      if (jumpProxy) {
        const inner = jumpProxy.replace(/'/g, "'\\''");
        const outer = `ssh ${jumpOpts} -o 'ProxyCommand=${inner}' -W %h:%p ${u}@${target.jumpHost}`;
        args.push("-o", `ProxyCommand=${outer}`);
      } else {
        const proxy = `ssh ${jumpOpts} -W %h:%p ${u}@${target.jumpHost}`;
        args.push("-o", `ProxyCommand=${proxy}`);
      }
    }
    args.push(`${target.user}@${target.host}`);

    this.proc = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (c: Buffer) => this.onData(c.toString()));
    this.proc.stderr.on("data", (c: Buffer) => this.onData(c.toString()));
    this.proc.on("close", () => this.onClose("ssh closed"));
    this.proc.on("error", (e) => this.onClose(`ssh error: ${e.message}`));

    // Warm up — silence PS1 / echo, then emit the ready marker. Timeout
    // protects against a wedged bastion that never completes login.
    const warmupTimer = setTimeout(() => {
      if (!this.warmed) this.onClose("warmup timeout");
    }, READY_TIMEOUT_MS);

    // Small initial delay so the remote shell has time to print its banner
    // and reach the prompt before we start sending commands. Shorter than
    // the per-call 1.5s in the legacy path because we only pay it once.
    setTimeout(() => {
      try {
        this.proc.stdin.write(
          `stty -echo 2>/dev/null; PS1='' PS2='' PROMPT_COMMAND=''; echo ${READY_MARKER}\n`,
        );
      } catch {}
    }, 500);

    this.warmupWaiters.push((ok) => clearTimeout(warmupTimer));
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    // Process complete lines only; keep any trailing partial in the buffer.
    let idx: number;
    // eslint-disable-next-line no-cond-assign
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.onLine(raw.replace(/\r$/, ""));
    }
  }

  private onLine(line: string) {
    if (!this.warmed) {
      if (line.trim() === READY_MARKER) {
        this.warmed = true;
        const w = this.warmupWaiters.splice(0);
        for (const fn of w) fn(true);
        this.pump();
      }
      return;
    }
    if (!this.current) return;
    const startMarker = `__AURA_CMD_START_${this.currentId}__`;
    const endPrefix = `__AURA_CMD_END_${this.currentId}__=`;
    // Drop echoed copies of the command we wrote — some PTY setups still
    // echo stdin despite `stty -echo` (e.g. when the remote shell reinits
    // its tty state). We identify echoes by exact literal match against
    // the markers themselves.
    if (line.trim() === `echo ${startMarker}` || line.includes(endPrefix + "$?")) return;
    if (line.trim() === startMarker) {
      this.currentInside = true;
      return;
    }
    if (line.includes(endPrefix)) {
      const m = line.match(new RegExp(endPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(-?\\d+)"));
      const exitCode = m ? parseInt(m[1], 10) : null;
      this.finishCurrent(exitCode ?? -1, exitCode === 0);
      return;
    }
    if (this.currentInside) {
      try { this.current.onStream(line); } catch {}
      this.currentLines.push(line);
    }
  }

  private finishCurrent(exitCode: number, success: boolean, error?: string) {
    if (!this.current) return;
    if (this.currentTimer) { clearTimeout(this.currentTimer); this.currentTimer = null; }
    const c = this.current;
    this.current = null;
    this.currentId = "";
    this.currentInside = false;
    this.currentLines = [];
    try { c.onComplete(success, exitCode, error); } catch {}
    this.pump();
  }

  private onClose(reason: string) {
    if (this.dead) return;
    this.dead = true;
    // Fail any current and queued callers.
    if (this.current) this.finishCurrent(-1, false, reason);
    const left = this.queue.splice(0);
    for (const r of left) {
      try { r.onComplete(false, null, reason); } catch {}
    }
    const w = this.warmupWaiters.splice(0);
    for (const fn of w) fn(false);
    try { rmSync(this.tmpDir, { recursive: true, force: true }); } catch {}
  }

  isDead(): boolean { return this.dead; }

  /**
   * Outstanding-work indicator for pool scheduling: queued jobs + 1 if a
   * command is currently executing. Used by the pool to pick the least
   * loaded session on each enqueue.
   */
  load(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  enqueue(req: BastionExecRequest) {
    if (this.dead) {
      try { req.onComplete(false, null, "session dead"); } catch {}
      return;
    }
    this.queue.push(req);
    this.lastUsed = Date.now();
    if (this.warmed) this.pump();
  }

  private pump() {
    if (this.dead || this.current) return;
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this.currentId = randomBytes(6).toString("hex");
    this.currentLines = [];
    this.currentInside = false;

    const startMarker = `__AURA_CMD_START_${this.currentId}__`;
    const endPrefix = `__AURA_CMD_END_${this.currentId}__=`;

    // Upload + execute via the existing shell. Heredoc into a tempfile is
    // reliable even for scripts with embedded quotes; we then run and
    // delete it, printing the exit code on a final line that our parser
    // recognises.
    const b64 = Buffer.from(next.script).toString("base64");
    const b64Lines = b64.match(/.{1,76}/g) ?? [b64];
    const remoteB64 = `/tmp/.aura-bmux-${this.currentId}.b64`;
    const remoteFile = `/tmp/.aura-bmux-${this.currentId}.sh`;

    const cmd = [
      `cat > ${remoteB64} <<'AURA_B64_EOF'`,
      ...b64Lines,
      `AURA_B64_EOF`,
      `echo ${startMarker}`,
      `base64 -d < ${remoteB64} > ${remoteFile} && rm -f ${remoteB64} && bash ${remoteFile}; __AURA_RC=$?; rm -f ${remoteFile}; echo ${endPrefix}$__AURA_RC`,
      ``,
    ].join("\n");

    try {
      this.proc.stdin.write(cmd);
    } catch (e) {
      this.finishCurrent(-1, false, e instanceof Error ? e.message : "stdin write failed");
      return;
    }

    this.currentTimer = setTimeout(() => {
      this.finishCurrent(-1, false, "exec timeout");
      // The shell may still be processing — easiest recovery is to nuke the
      // session so the next call starts fresh.
      this.kill("exec timeout");
    }, EXEC_TIMEOUT_MS);
  }

  kill(reason: string) {
    try { this.proc.kill("SIGKILL"); } catch {}
    this.onClose(reason);
  }
}

/**
 * Per-target pool of up to POOL_SIZE sessions. Each session is still
 * single-threaded (one command in flight at a time — a shared shell cannot
 * safely interleave stdin/stdout from concurrent commands), but N of them
 * run in parallel and dispatch picks the least-loaded on each enqueue.
 *
 * Sessions are spawned lazily: the first enqueue creates session #1, and
 * additional ones are added only when all existing sessions already have
 * work queued. Bursty callers pay handshake cost as they ramp up; steady
 * callers settle on a stable working set well under POOL_SIZE.
 */
class BastionPool {
  private sessions: BastionSession[] = [];
  lastUsed = Date.now();
  constructor(private target: BastionTarget) {}

  enqueue(req: BastionExecRequest) {
    this.lastUsed = Date.now();
    // Drop dead sessions lazily — no background reaper needed per-pool.
    this.sessions = this.sessions.filter((s) => !s.isDead());

    // Pick the least-loaded live session. If everyone is already working
    // (current + queue > 0) and the pool hasn't hit its cap, open a new
    // session to absorb the burst.
    const pickLeast = (): BastionSession | null => {
      let best: BastionSession | null = null;
      let bestLoad = Infinity;
      for (const s of this.sessions) {
        const load = s.load();
        if (load < bestLoad) { bestLoad = load; best = s; }
      }
      return best;
    };
    const existing = pickLeast();
    const allBusy = existing !== null && existing.load() >= 1;
    let target = existing;
    if ((!target || allBusy) && this.sessions.length < POOL_SIZE) {
      target = new BastionSession(this.target);
      this.sessions.push(target);
    }
    if (!target) target = existing!; // pool cap reached — queue on least-loaded
    target.enqueue(req);
  }

  isIdle(now: number): boolean {
    return now - this.lastUsed > TTL_MS && this.sessions.every((s) => s.load() === 0);
  }

  kill(reason: string) {
    for (const s of this.sessions) s.kill(reason);
    this.sessions = [];
  }

  size(): number { return this.sessions.length; }
}

const pools = new Map<string, BastionPool>();

export function getBastionSession(target: BastionTarget): { enqueue: (req: BastionExecRequest) => void } {
  const key = targetKey(target);
  let p = pools.get(key);
  if (!p) {
    p = new BastionPool(target);
    pools.set(key, p);
  }
  return p;
}

export function dropBastionSession(target: BastionTarget): void {
  const key = targetKey(target);
  const p = pools.get(key);
  if (!p) return;
  pools.delete(key);
  p.kill("explicit drop");
}

// Idle sweep. Runs every minute; evicts pools that have been idle beyond TTL.
if (bastionMuxEnabled()) {
  setInterval(() => {
    const now = Date.now();
    for (const [k, p] of pools) {
      if (p.isIdle(now)) {
        pools.delete(k);
        p.kill("idle sweep");
      }
    }
  }, 60_000).unref?.();
}
