/**
 * Lightweight SSH liveness probe for clusters.
 *
 * Callable from any route (typically the cluster detail GET). Probes in the
 * background with a short timeout, debounced per-cluster so we don't spawn
 * ssh twice for the same cluster inside `DEBOUNCE_MS`.
 *
 * Flips cluster.status:
 *   ACTIVE  → OFFLINE  only after two *consecutive* probe failures (avoids
 *                      flipping on a single spurious timeout).
 *   OFFLINE → ACTIVE   immediately on the first successful probe.
 * Leaves PROVISIONING untouched (bootstrap in flight).
 */

import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prisma } from "./prisma";

const DEBOUNCE_MS = 30_000;
// 15s matches the `ConnectTimeout` we use for real ssh-exec calls. Cold
// TCP handshakes and bastion auth sometimes exceed 5s under load — the
// previous 5s default was flipping clusters to OFFLINE spuriously.
const PROBE_TIMEOUT_MS = 15_000;

const lastProbeAt = new Map<string, number>();
// Count of consecutive failures per cluster. Reset to 0 on success. An
// ACTIVE → OFFLINE transition requires this to reach 2.
const failStreak = new Map<string, number>();

function sshPing(args: {
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
}): Promise<boolean> {
  return new Promise((resolve) => {
    const tmp = mkdtempSync(join(tmpdir(), "aura-hp-"));
    const keyPath = join(tmp, "k");
    writeFileSync(keyPath, args.privateKey, { mode: 0o600 });
    chmodSync(keyPath, 0o600);

    const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} };

    // Matches lib/ssh-exec.ts: host ProxyCommand wins outright; jump
    // ProxyCommand (when set) nests inside the jump-W ssh.
    const jumpArgs: string[] = [];
    const hostProxy = args.proxyCommand?.trim() || "";
    const jumpProxy = args.jumpProxyCommand?.trim() || "";
    if (hostProxy) {
      jumpArgs.push("-o", `ProxyCommand=${hostProxy}`);
    } else if (args.jumpHost) {
      let jumpKeyPath = keyPath;
      if (args.jumpPrivateKey && args.jumpPrivateKey !== args.privateKey) {
        jumpKeyPath = join(tmp, "jk");
        writeFileSync(jumpKeyPath, args.jumpPrivateKey, { mode: 0o600 });
        chmodSync(jumpKeyPath, 0o600);
      }
      const u = args.jumpUser || "root";
      const p = args.jumpPort || 22;
      const jumpOpts = `-i ${jumpKeyPath} -p ${p} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o LogLevel=ERROR`;
      if (jumpProxy) {
        const inner = jumpProxy.replace(/'/g, "'\\''");
        jumpArgs.push("-o", `ProxyCommand=ssh ${jumpOpts} -o 'ProxyCommand=${inner}' -W %h:%p ${u}@${args.jumpHost}`);
      } else {
        jumpArgs.push("-o", `ProxyCommand=ssh ${jumpOpts} -W %h:%p ${u}@${args.jumpHost}`);
      }
    }

    const proc = spawn("ssh", [
      "-i", keyPath,
      "-p", String(args.port),
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "BatchMode=yes",
      "-o", "LogLevel=ERROR",
      "-o", `ConnectTimeout=${Math.ceil(PROBE_TIMEOUT_MS / 1000)}`,
      ...jumpArgs,
      `${args.user}@${args.host}`,
      "echo __aura_ping__",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    proc.stdout.on("data", (c: Buffer) => { out += c.toString(); });

    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, PROBE_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      resolve(code === 0 && out.includes("__aura_ping__"));
    });
    proc.on("error", () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    });
  });
}

/**
 * Kick off a debounced background probe. Returns immediately; the DB is
 * updated when the probe finishes. Safe to call on every GET.
 */
export function probeClusterHealth(clusterId: string): void {
  const now = Date.now();
  const prev = lastProbeAt.get(clusterId) ?? 0;
  if (now - prev < DEBOUNCE_MS) return;
  lastProbeAt.set(clusterId, now);

  (async () => {
    try {
      const cluster = await prisma.cluster.findUnique({
        where: { id: clusterId },
        include: { sshKey: true },
      });
      if (!cluster || !cluster.sshKey) return;
      if (cluster.status === "PROVISIONING") return;
      if (cluster.connectionMode !== "SSH") return;

      // Fetch a separate jump key if configured, so the probe's bastion hop
      // uses the correct identity (matches getClusterSshTarget).
      let jumpPrivateKey: string | null = null;
      if (cluster.sshJumpKeyId && cluster.sshJumpKeyId !== cluster.sshKeyId) {
        const jk = await prisma.sshKey.findUnique({ where: { id: cluster.sshJumpKeyId } });
        jumpPrivateKey = jk?.privateKey ?? null;
      }

      const alive = await sshPing({
        host: cluster.controllerHost,
        user: cluster.sshUser,
        port: cluster.sshPort,
        privateKey: cluster.sshKey.privateKey,
        jumpHost: cluster.sshJumpHost,
        jumpUser: cluster.sshJumpUser,
        jumpPort: cluster.sshJumpPort,
        jumpPrivateKey,
        proxyCommand: cluster.sshProxyCommand,
        jumpProxyCommand: cluster.sshJumpProxyCommand,
      });

      if (alive) {
        failStreak.set(clusterId, 0);
        if (cluster.status !== "ACTIVE") {
          await prisma.cluster.update({
            where: { id: clusterId },
            data: { status: "ACTIVE" },
          });
        }
        return;
      }

      // Failure. Only flip to OFFLINE after two consecutive failures so a
      // single spurious probe timeout doesn't alarm users whose cluster is
      // actually reachable.
      const streak = (failStreak.get(clusterId) ?? 0) + 1;
      failStreak.set(clusterId, streak);
      if (streak >= 2 && cluster.status !== "OFFLINE") {
        await prisma.cluster.update({
          where: { id: clusterId },
          data: { status: "OFFLINE" },
        });
      }
    } catch {}
  })();
}
