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

import { prisma } from "./prisma";
import { sshExecSimple } from "./ssh-exec";

const DEBOUNCE_MS = 30_000;

const lastProbeAt = new Map<string, number>();
// Count of consecutive failures per cluster. Reset to 0 on success. An
// ACTIVE → OFFLINE transition requires this to reach 2.
const failStreak = new Map<string, number>();

interface PingResult { ok: boolean; message: string }

// Route the probe through sshExecSimple so it respects bastion mode, jump
// hops, separate jump keys, and ProxyCommand overrides — identical to what
// Test-SSH uses. The previous hand-rolled spawn failed on shell-only
// bastions with "ssh exited with code 255".
async function sshPing(cluster: {
  controllerHost: string;
  sshUser: string;
  sshPort: number;
  sshBastion: boolean;
  sshJumpHost: string | null;
  sshJumpUser: string | null;
  sshJumpPort: number | null;
  sshProxyCommand: string | null;
  sshJumpProxyCommand: string | null;
  sshKey: { privateKey: string };
  _jumpPrivateKey: string | null;
}): Promise<PingResult> {
  const result = await sshExecSimple(
    {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
      jumpHost: cluster.sshJumpHost,
      jumpUser: cluster.sshJumpUser,
      jumpPort: cluster.sshJumpPort,
      jumpPrivateKey: cluster._jumpPrivateKey,
      proxyCommand: cluster.sshProxyCommand,
      jumpProxyCommand: cluster.sshJumpProxyCommand,
    },
    "echo __aura_ping__",
  );
  const stdout = (result.stdout ?? "").trim();
  const ok = !!result.success && stdout.includes("__aura_ping__");
  if (ok) return { ok: true, message: "alive" };

  const errLine =
    (result.stderr ?? "").trim().split("\n").filter(Boolean).slice(-1)[0] ||
    stdout.split("\n").filter(Boolean).slice(-1)[0] ||
    `ssh exited with code ${result.exitCode}`;
  const message = errLine.length > 160 ? errLine.slice(0, 160) + "…" : errLine;
  return { ok: false, message };
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
      let _jumpPrivateKey: string | null = null;
      if (cluster.sshJumpKeyId && cluster.sshJumpKeyId !== cluster.sshKeyId) {
        const jk = await prisma.sshKey.findUnique({ where: { id: cluster.sshJumpKeyId } });
        _jumpPrivateKey = jk?.privateKey ?? null;
      }

      // TS can't narrow `cluster.sshKey` across the spread, so pass explicitly.
      const result = await sshPing({ ...cluster, sshKey: cluster.sshKey, _jumpPrivateKey });

      // Persist probe outcome into cluster.config.health so the UI can show
      // why status flipped (timestamp + last error + consecutive-fail count).
      const streakAfter = result.ok ? 0 : (failStreak.get(clusterId) ?? 0) + 1;
      failStreak.set(clusterId, streakAfter);

      const cfg = (cluster.config ?? {}) as Record<string, unknown>;
      cfg.health = {
        lastProbeAt: new Date().toISOString(),
        alive: result.ok,
        message: result.message,
        failStreak: streakAfter,
      };

      const desired: "ACTIVE" | "OFFLINE" | null =
        result.ok && cluster.status !== "ACTIVE" ? "ACTIVE"
        : !result.ok && streakAfter >= 2 && cluster.status !== "OFFLINE" ? "OFFLINE"
        : null;

      await prisma.cluster.update({
        where: { id: clusterId },
        data: {
          config: cfg as never,
          ...(desired ? { status: desired } : {}),
        },
      });
    } catch {}
  })();
}
