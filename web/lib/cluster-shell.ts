/**
 * Interactive PTY shell pipe for the admin cluster Terminal.
 *
 * Two transports were considered:
 *
 * 1. WebSocket — would be lower-latency, but VS Code's Remote-SSH port
 *    forward (which is how some operators reach the dev server) drops the
 *    `Connection: Upgrade` handshake silently. Plain HTTP relays fine.
 * 2. SSE + POST input — what we ship. Server-Sent Events for downstream
 *    PTY bytes, regular POST for keystrokes and resize. This is the same
 *    pattern terminal-view.tsx already uses for app sessions, so we know
 *    it survives the forwarding layer.
 *
 * Flow:
 *   1. POST /api/clusters/[id]/shell-token (session admin) → { sessionId }
 *   2. EventSource GET /api/cluster-shell/[sessionId]/stream — server
 *      starts the PTY (ssh -tt to controller, optionally chained into a
 *      node IP) on connection and writes raw PTY bytes back as
 *      base64-encoded SSE events.
 *   3. POST /api/cluster-shell/[sessionId]/input with
 *      { type: "input", data: <base64> } or { type: "resize", cols, rows }.
 *   4. Browser closes the EventSource (dialog close, unmount) → server
 *      kills the PTY and frees the session.
 */

import { spawn as ptySpawn, type IPty } from "node-pty";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

import { getClusterSshTarget, buildJumpArgs } from "./ssh-exec";

interface ShellSession {
  userId: string;
  clusterId: string;
  nodeIp?: string;
  /** Filled in once the SSE stream actually opens and the PTY spawns. */
  pty?: IPty;
  /** Cleanup callback set after spawn. */
  cleanup?: () => void;
  /** Output callback the SSE handler installs. */
  onOutput?: (chunk: Buffer) => void;
  /** Exit callback the SSE handler installs. */
  onExit?: (exitCode: number) => void;
  /** Bytes queued before the SSE stream picked up the handle. */
  buffered: Buffer[];
  /** True once `onExit` already fired so we don't deliver twice. */
  exited: boolean;
  expiresAt: number;
}

const SESSION_TTL_MS = 60_000; // until SSE connects; after that, kept alive while streaming
// Defence-in-depth: nodeIp is interpolated into a remote command string, so
// we refuse anything that isn't a plain hostname/IP. Mint and consume both
// check it.
const NODE_TARGET_RE = /^[A-Za-z0-9._-]{1,255}$/;

// In Next.js dev, the App-Router API route module (mints / handles input)
// and the App-Router SSE route module (streams output) end up in different
// webpack module graphs from each other under hot-reload. A plain
// module-scoped Map would lose state across them. Park the registry on
// globalThis so every copy of this module shares one source of truth.
const globalForSessions = globalThis as unknown as {
  __auraShellSessions?: Map<string, ShellSession>;
};
const sessions: Map<string, ShellSession> =
  globalForSessions.__auraShellSessions ?? new Map<string, ShellSession>();
globalForSessions.__auraShellSessions = sessions;

function gcSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    // Only expire sessions that never had their PTY attached. Once the SSE
    // pipe wires up the PTY, the cleanup runs on PTY exit or stream close.
    if (!s.pty && s.expiresAt < now) {
      sessions.delete(id);
    }
  }
}

export function mintShellSession(
  userId: string,
  clusterId: string,
  nodeIp?: string,
): string {
  gcSessions();
  if (nodeIp && !NODE_TARGET_RE.test(nodeIp)) {
    throw new Error("invalid nodeIp");
  }
  const sessionId = randomBytes(24).toString("base64url");
  sessions.set(sessionId, {
    userId,
    clusterId,
    nodeIp,
    buffered: [],
    exited: false,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return sessionId;
}

export function getShellSession(sessionId: string): ShellSession | null {
  return sessions.get(sessionId) ?? null;
}

export function dropShellSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  try { s.cleanup?.(); } catch {}
  sessions.delete(sessionId);
}

/**
 * Spawn the PTY for an already-minted session and wire output back through
 * the supplied callbacks. Returns a teardown function the caller must invoke
 * when the consumer (the SSE response stream) closes. Safe to call once per
 * session — subsequent calls error.
 */
export async function attachShellSession(
  sessionId: string,
  callbacks: {
    onOutput: (chunk: Buffer) => void;
    onExit: (exitCode: number) => void;
    onError: (msg: string) => void;
  },
): Promise<() => void> {
  const session = sessions.get(sessionId);
  if (!session) {
    callbacks.onError("Session not found or expired");
    return () => {};
  }
  if (session.pty) {
    callbacks.onError("Session already attached");
    return () => {};
  }

  const target = await getClusterSshTarget(session.clusterId);
  if (!target) {
    callbacks.onError("Cluster has no SSH key assigned");
    sessions.delete(sessionId);
    return () => {};
  }

  if (session.nodeIp && !NODE_TARGET_RE.test(session.nodeIp)) {
    callbacks.onError("Invalid node target");
    sessions.delete(sessionId);
    return () => {};
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "aura-shell-"));
  const keyPath = join(tmpDir, "ssh_key");
  writeFileSync(keyPath, target.privateKey, { mode: 0o600 });
  chmodSync(keyPath, 0o600);

  const sshArgs = [
    "-tt",
    "-i", keyPath,
    "-p", String(target.port),
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
    ...buildJumpArgs(target, tmpDir, keyPath),
    `${target.user}@${target.host}`,
  ];

  if (session.nodeIp) {
    sshArgs.push(
      `exec ssh -tt -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR ${session.nodeIp}`,
    );
  }

  let pty: IPty;
  try {
    pty = ptySpawn("ssh", sshArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" } as { [k: string]: string },
      encoding: null,
    });
  } catch (err) {
    callbacks.onError(`Failed to start shell: ${(err as Error).message}`);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    sessions.delete(sessionId);
    return () => {};
  }

  session.pty = pty;
  session.onOutput = callbacks.onOutput;
  session.onExit = callbacks.onExit;

  // Banner so the client gets immediate proof the SSE pipe is alive even
  // before ssh produces output.
  const dest = session.nodeIp
    ? `${target.user}@${target.host} → ${session.nodeIp}`
    : `${target.user}@${target.host}`;
  callbacks.onOutput(
    Buffer.from(`\x1b[1;36m[aura] Connecting to ${dest}…\x1b[0m\r\n`),
  );

  pty.onData((data) => {
    const buf =
      typeof data === "string" ? Buffer.from(data, "utf8") : (data as unknown as Buffer);
    session.onOutput?.(buf);
  });

  pty.onExit(({ exitCode }) => {
    if (session.exited) return;
    session.exited = true;
    session.onExit?.(exitCode);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    sessions.delete(sessionId);
  });

  const teardown = () => {
    try { pty.kill(); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    sessions.delete(sessionId);
  };
  session.cleanup = teardown;
  return teardown;
}

export function writeShellInput(sessionId: string, data: Buffer): boolean {
  const s = sessions.get(sessionId);
  if (!s || !s.pty) return false;
  try {
    s.pty.write(data);
    return true;
  } catch {
    return false;
  }
}

export function resizeShell(sessionId: string, cols: number, rows: number): boolean {
  const s = sessions.get(sessionId);
  if (!s || !s.pty) return false;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
    return false;
  }
  try {
    s.pty.resize(cols, rows);
    return true;
  } catch {
    return false;
  }
}
