/**
 * Per-cluster SSH local port-forward to the cluster's Grafana.
 *
 * Why: each Grafana page load issues 30+ requests for static assets. Doing
 * those one-by-one through `ssh + curl` would take a minute per page. Instead
 * we maintain a single `ssh -N -L <localport>:<grafanaIp>:<grafanaPort>`
 * process per cluster and let our HTTP proxy hit it directly with Node fetch.
 *
 * The pool is in-memory; restarting the web process tears down all tunnels
 * and the next request re-establishes them lazily.
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
  // Bastion-mode hosts force an interactive shell on every connection.
  // `ssh -N` (no remote command) returns immediately because the forced
  // shell sees EOF on stdin. We work around this by allocating a PTY and
  // running `sleep infinity` so the channel stays open for forwarded
  // traffic.
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

/**
 * Force-drop the cached tunnel for a cluster. Called by the proxy on
 * fetch failure (e.g. ECONNREFUSED) so the next request lazily
 * re-establishes a fresh tunnel — covers the "Grafana restarted under
 * us" case after a redeploy.
 */
export function dropGrafanaTunnel(clusterId: string): void {
  const t = tunnels.get(clusterId);
  if (!t) return;
  try { t.proc.kill(); } catch {}
  try { rmSync(t.tmpDir, { recursive: true, force: true }); } catch {}
  tunnels.delete(clusterId);
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

export async function getGrafanaTunnel(
  clusterId: string,
  controllerTarget: TunnelTarget,
  remoteIp: string,
  remotePort: number,
): Promise<number> {
  const existing = tunnels.get(clusterId);
  if (existing && existing.proc.exitCode === null && !existing.proc.killed
      && existing.ip === remoteIp && existing.remotePort === remotePort) {
    await existing.ready;
    return existing.port;
  }
  // Tear down stale (different target / dead).
  if (existing) {
    try { existing.proc.kill(); } catch {}
    try { rmSync(existing.tmpDir, { recursive: true, force: true }); } catch {}
    tunnels.delete(clusterId);
  }

  const localPort = await freePort();
  const tmpDir = mkdtempSync(join(tmpdir(), "aura-graf-tunnel-"));
  const keyPath = join(tmpDir, "key");
  writeFileSync(keyPath, controllerTarget.privateKey, { mode: 0o600 });
  chmodSync(keyPath, 0o600);

  // Bastion-mode hosts force an interactive shell on every connection,
  // so `-N` (no remote command) closes immediately. We allocate a PTY
  // (`-tt`) and run `sleep infinity` to keep the channel open for the
  // forwarded port. For non-bastion hosts the simple `-N` form is fine.
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
    "-o", "LogLevel=ERROR",
    ...buildJumpArg(controllerTarget, keyPath, tmpDir),
  ];
  const args = controllerTarget.bastion
    ? [...baseArgs, "-tt", `${controllerTarget.user}@${controllerTarget.host}`, "exec sleep 86400"]
    : [...baseArgs, "-N", `${controllerTarget.user}@${controllerTarget.host}`];

  // Capture both streams — bastion output noise lands on stdout via the PTY,
  // ssh-level errors land on stderr. Either may explain a sudden close.
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

  const ready = (async () => {
    // Race the listener-up check against the proc dying. Either resolves.
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const onClose = () => {
        if (done) return;
        done = true;
        const tail = (stderr.slice(-200) || stdout.slice(-200) || "no output").replace(/\s+/g, " ").trim();
        reject(new Error(`ssh tunnel died: ${tail}`));
      };
      proc.once("close", onClose);
      proc.once("error", onClose);
      waitForListen(localPort, 10000)
        .then(() => { if (!done) { done = true; proc.removeListener("close", onClose); resolve(); } })
        .catch((e) => { if (!done) { done = true; proc.removeListener("close", onClose); reject(e); } });
    });
  })();

  proc.on("close", () => {
    tunnels.delete(clusterId);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const tun: Tunnel = { port: localPort, proc, tmpDir, ready, ip: remoteIp, remotePort };
  tunnels.set(clusterId, tun);
  await ready;
  return localPort;
}
