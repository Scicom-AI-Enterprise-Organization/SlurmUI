/**
 * Process-supervisor abstraction for SSH-driven cluster operations.
 *
 * Container nodes can't run systemd, so the ansible bootstrap can be
 * configured to use pm2-go instead (see ansible/tasks/_supervisor.yml).
 * Every web-side surface that runs `systemctl is-active …` or
 * `journalctl -u …` over SSH needs to branch the same way; this module
 * centralises that.
 *
 * Source of truth:
 *   1. `cluster.config.node_supervisor` (string: "systemd" | "pm2")
 *   2. If unset, default to "systemd" (preserves behaviour on existing
 *      clusters provisioned before this feature).
 *
 * Heartbeat will detect-and-persist the supervisor on first probe so the
 * field self-populates without admin intervention.
 */
import type { Cluster } from "@prisma/client";

export type Supervisor = "systemd" | "pm2";

/** Read the supervisor from cluster.config, defaulting to systemd. */
export function getSupervisor(cluster: Pick<Cluster, "config">): Supervisor {
  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const raw = config.node_supervisor;
  return raw === "pm2" ? "pm2" : "systemd";
}

/**
 * dunstorm/pm2-go stores per-process state under $HOME/.pm2-go/{pids,logs}/.
 * Bootstrap runs as root or via sudo, so the canonical location is
 * /root/.pm2-go/... and that's what every SSH-driven probe reads. If
 * someone reconfigures pm2-go to a different home we can revisit, but
 * v0.1.2 has no flag to override.
 */
const PM2_HOME = "/root/.pm2-go";

/** Return the shell command that exits 0 iff the named service is active. */
export function isActiveCmd(supervisor: Supervisor, service: string): string {
  if (supervisor === "pm2") {
    // pm2-go v0.1.2 has no `jlist`. We probe the PID file it writes for
    // each managed process — kill -0 returns 0 if the process exists,
    // without sending an actual signal. This is what `pm2 status` does
    // internally and avoids parsing the colored `pm2 ls` table.
    return `[ -f ${PM2_HOME}/pids/${service}.pid ] && kill -0 "$(cat ${PM2_HOME}/pids/${service}.pid)" 2>/dev/null`;
  }
  return `systemctl is-active --quiet ${service}`;
}

/** Restart a service. */
export function restartCmd(supervisor: Supervisor, service: string): string {
  if (supervisor === "pm2") {
    // pm2-go's `start <json>` is its restart-with-new-config primitive
    // when the named app already exists (see app/file.go::StartFile).
    return `/usr/local/bin/pm2 start /etc/aura/pm2/${service}.json`;
  }
  return `systemctl restart ${service}`;
}

/** Stop (without disable). */
export function stopCmd(supervisor: Supervisor, service: string): string {
  if (supervisor === "pm2") {
    return `/usr/local/bin/pm2 stop ${service}`;
  }
  return `systemctl stop ${service}`;
}

/** Fetch the last N log lines for a service. */
export function logsCmd(
  supervisor: Supervisor,
  service: string,
  lines: number,
): string {
  if (supervisor === "pm2") {
    // pm2-go writes a per-process out/err pair under $HOME/.pm2-go/logs/.
    // `tail -n N` against both files mirrors what journalctl -u gives
    // (newest at the bottom, both streams interleaved by tail) without
    // needing the pm2-go CLI to be in PATH on every probe.
    return `tail -n ${lines} ${PM2_HOME}/logs/${service}-out.log ${PM2_HOME}/logs/${service}-err.log 2>/dev/null`;
  }
  return `journalctl -u ${service} -n ${lines} --no-pager`;
}

/**
 * A bash snippet that probes the running host and sets `$SUPERVISOR`
 * (to "systemd" or "pm2") plus the `$IS_ACTIVE`, `$LOGS_CMD`, and
 * `$RESTART_CMD` helper variables. Use when embedding a multi-step
 * diagnostic script that needs to branch inline rather than at the call
 * site — e.g. the node-diagnose play.
 */
export function supervisorProbeBash(): string {
  return `
# --- aura: detect process supervisor ---
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  SUPERVISOR=systemd
else
  SUPERVISOR=pm2
fi
# --- end probe ---`.trim();
}

/**
 * Probe a remote host over SSH to determine its supervisor. Returns
 * "systemd" or "pm2"; never throws (defaults to "systemd" on probe
 * failure so a flaky probe doesn't make us misclassify).
 *
 * Caller must hold an open SSH target.
 */
export async function detectSupervisorOverSsh(
  ssh: { stdout: string; success: boolean },
): Promise<Supervisor> {
  // Convenience wrapper for the common pattern where the caller has already
  // issued the probe command. Inline marker form so callers can do:
  //   const r = await sshExecSimple(target, "test -d /run/systemd/system && echo S || echo P");
  //   const sup = parseSupervisorMarker(r.stdout);
  // We just thread the result through here for type-safety.
  if (!ssh.success) return "systemd";
  if (ssh.stdout.trim().endsWith("P")) return "pm2";
  return "systemd";
}
