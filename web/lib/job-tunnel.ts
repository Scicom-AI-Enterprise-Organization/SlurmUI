/**
 * Per-job SSH local port-forward to <jobNode>:<proxyPort>.
 *
 * Mirrors lib/grafana-tunnel.ts. Workers typically live on a private
 * network only the controller can reach — directly opening a TCP socket
 * from the web server times out. We maintain a single
 * `ssh -N -L <localport>:<jobNode>:<proxyPort>` per (clusterId, jobId)
 * and let the HTTP / WS proxy talk to 127.0.0.1:<localPort> instead.
 *
 * Cache key is `<clusterId>:<jobId>`; tunnel is rebuilt when the node IP
 * or port changes (job rescheduled, user edits port). Process death
 * removes it from the pool so the next request re-establishes lazily.
 */

import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer, connect as netConnect } from "net";

export interface TunnelTarget {
  host: string;
  user: string;
  port: number;
  privateKey: string;
  bastion?: boolean;
  jumpHost?: string | null;
  jumpUser?: string | null;
  jumpPort?: number | null;
  jumpPrivateKey?: string | null;
  proxyCommand?: string | null;
  jumpProxyCommand?: string | null;
}

interface Tunnel {
  port: number;
  proc: ChildProcess;
  tmpDir: string;
  ready: Promise<void>;
  ip: string;
  remotePort: number;
}

const tunnels = new Map<string, Tunnel>();

export function dropJobTunnel(clusterId: string, jobId: string): void {
  const key = `${clusterId}:${jobId}`;
  const t = tunnels.get(key);
  if (!t) return;
  try { t.proc.kill(); } catch {}
  try { rmSync(t.tmpDir, { recursive: true, force: true }); } catch {}
  tunnels.delete(key);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => (p ? resolve(p) : reject(new Error("no free port"))));
    });
    s.on("error", reject);
  });
}

function buildJumpArg(target: TunnelTarget, mainKeyPath: string, tmpDir: string): string[] {
  const hostProxy = target.proxyCommand?.trim() || "";
  if (hostProxy) return ["-o", `ProxyCommand=${hostProxy}`];
  if (!target.jumpHost) return [];
  let jumpKeyPath = mainKeyPath;
  if (target.jumpPrivateKey && target.jumpPrivateKey !== target.privateKey) {
    jumpKeyPath = join(tmpDir, "jump_key");
    writeFileSync(jumpKeyPath, target.jumpPrivateKey, { mode: 0o600 });
    chmodSync(jumpKeyPath, 0o600);
  }
  const u = target.jumpUser || "root";
  const p = target.jumpPort || 22;
  const jumpProxy = target.jumpProxyCommand?.trim() || "";
  const jumpOpts = `-i ${jumpKeyPath} -p ${p} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o LogLevel=ERROR`;
  if (jumpProxy) {
    const inner = jumpProxy.replace(/'/g, "'\\''");
    return ["-o", `ProxyCommand=ssh ${jumpOpts} -o 'ProxyCommand=${inner}' -W %h:%p ${u}@${target.jumpHost}`];
  }
  return ["-o", `ProxyCommand=ssh ${jumpOpts} -W %h:%p ${u}@${target.jumpHost}`];
}

function waitForListen(port: number, deadlineMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = () => {
      const sock = netConnect(port, "127.0.0.1");
      sock.once("connect", () => { sock.end(); resolve(); });
      sock.once("error", () => {
        if (Date.now() - start > deadlineMs) reject(new Error("tunnel never came up"));
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

export async function getJobTunnel(
  clusterId: string,
  jobId: string,
  controllerTarget: TunnelTarget,
  remoteIp: string,
  remotePort: number,
): Promise<number> {
  const key = `${clusterId}:${jobId}`;
  const existing = tunnels.get(key);
  if (existing && existing.proc.exitCode === null && !existing.proc.killed
      && existing.ip === remoteIp && existing.remotePort === remotePort) {
    await existing.ready;
    return existing.port;
  }
  if (existing) {
    try { existing.proc.kill(); } catch {}
    try { rmSync(existing.tmpDir, { recursive: true, force: true }); } catch {}
    tunnels.delete(key);
  }

  const localPort = await freePort();
  const tmpDir = mkdtempSync(join(tmpdir(), "aura-job-tunnel-"));
  const keyPath = join(tmpDir, "key");
  writeFileSync(keyPath, controllerTarget.privateKey, { mode: 0o600 });
  chmodSync(keyPath, 0o600);

  const baseArgs = [
    "-i", keyPath,
    "-p", String(controllerTarget.port),
    "-L", `127.0.0.1:${localPort}:${remoteIp}:${remotePort}`,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "BatchMode=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
    // VERBOSE so silent failures (auth handshake, channel rejection) leave
    // a usable trail in the captured stderr. We surface this in the
    // "ssh tunnel died" error, which is otherwise unhelpfully empty when
    // the remote shell exits cleanly with no diagnostic.
    "-vv",
    ...buildJumpArg(controllerTarget, keyPath, tmpDir),
  ];
  const args = controllerTarget.bastion
    ? [...baseArgs, "-tt", `${controllerTarget.user}@${controllerTarget.host}`, "exec sleep 86400"]
    : [...baseArgs, "-N", `${controllerTarget.user}@${controllerTarget.host}`];

  const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  const append = (sink: "out" | "err") => (b: Buffer) => {
    const s = b.toString();
    if (sink === "out") {
      stdout += s;
      if (stdout.length > 4096) stdout = stdout.slice(-4096);
    } else {
      stderr += s;
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    }
  };
  proc.stdout?.on("data", append("out"));
  proc.stderr?.on("data", append("err"));

  // Listen-budget: bastion-mode handshakes (login banner + interactive
  // PTY warmup + sleep exec) routinely take 10-25s on first connect even
  // when everything is healthy. Direct (non-bastion) connects come up in
  // <2s on a normal LAN. Be generous either way — a failure is loud
  // (the proc.error / proc.close handlers fire).
  const listenBudgetMs = controllerTarget.bastion ? 30_000 : 15_000;

  const ready = (async () => {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const onClose = () => {
        if (done) return;
        done = true;
        // With -vv, ssh prints a lot. Keep more of the tail so a real
        // diagnostic line (auth failure, host unreachable, etc.) survives
        // the truncation when stderr is dense.
        const tail = (stderr.slice(-1500) || stdout.slice(-1500) || "no output").trim();
        const exit = proc.exitCode;
        reject(new Error(`ssh tunnel died (exit=${exit ?? "?"}): ${tail}`));
      };
      proc.once("close", onClose);
      proc.once("error", onClose);
      waitForListen(localPort, listenBudgetMs)
        .then(() => { if (!done) { done = true; proc.removeListener("close", onClose); resolve(); } })
        .catch((e) => {
          if (done) return;
          done = true;
          proc.removeListener("close", onClose);
          // The "tunnel never came up" message is unhelpful by itself —
          // include the captured -vv stderr tail so we can see whether
          // ssh got stuck at handshake / auth / banner / port forward.
          // Also kill the lingering proc so we don't leak it.
          try { proc.kill("SIGTERM"); } catch {}
          const tail = (stderr.slice(-1500) || stdout.slice(-1500) || "(no ssh output)").trim();
          const detail = e instanceof Error ? e.message : String(e);
          reject(new Error(`${detail} (after ${listenBudgetMs}ms; ssh -vv tail: ${tail})`));
        });
    });
  })();

  proc.on("close", () => {
    tunnels.delete(key);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const tun: Tunnel = { port: localPort, proc, tmpDir, ready, ip: remoteIp, remotePort };
  tunnels.set(key, tun);
  await ready;
  return localPort;
}
