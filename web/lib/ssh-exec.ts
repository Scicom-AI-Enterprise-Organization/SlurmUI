/**
 * SSH command execution layer for clusters in SSH connection mode.
 *
 * Provides the same streaming interface as the NATS path:
 *   onStream(line, seq) — live output lines
 *   onComplete(success, payload) — final result
 */

import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prisma } from "./prisma";

interface SshTarget {
  host: string;
  user: string;
  port: number;
  privateKey: string; // raw PEM content
  bastion?: boolean;  // true if SSH server is a bastion that only supports interactive shell
  // ProxyJump (ssh -J) — when set, ssh routes through this host first.
  jumpHost?: string | null;
  jumpUser?: string | null;
  jumpPort?: number | null;
  // Optional: raw PEM for the jump hop when it needs a different key from
  // the destination. When unset, the same `privateKey` is used for both hops.
  jumpPrivateKey?: string | null;
  // Raw -o ProxyCommand override for the primary hop (to the controller).
  // Wins over jumpHost — ssh reaches the controller via this command.
  proxyCommand?: string | null;
  // Raw -o ProxyCommand override for the jump hop (the jumphost is reached
  // via this command). Nested inside the jump-W ssh when both jumpHost and
  // this are set.
  jumpProxyCommand?: string | null;
}

/**
 * Build the jump arguments for ssh. Always uses an explicit `ProxyCommand`
 * so the jump-hop flags (StrictHostKeyChecking, IdentityFile, etc.) are
 * guaranteed to apply — OpenSSH < 8.9's `-J` silently drops `-i` and strict
 * host-key settings when it invokes the child ssh.
 *
 * `tmpDir` is where we plant the jump key (when different from the main key).
 * Caller is responsible for deleting it (every spawn helper rm -rf's its
 * tmpDir when the process exits).
 */
function buildJumpArgs(target: SshTarget, tmpDir: string, mainKeyPath: string): string[] {
  const hostProxy = target.proxyCommand?.trim() || "";
  const jumpProxy = target.jumpProxyCommand?.trim() || "";
  const hasHostProxy = hostProxy.length > 0;
  const hasJump = !!target.jumpHost;

  // Host ProxyCommand wins — it's the direct transport to the controller.
  // Jump fields are ignored in this mode.
  if (hasHostProxy) {
    return ["-o", `ProxyCommand=${hostProxy}`];
  }
  if (!hasJump) return [];

  // Build the jump-hop sub-ssh. Uses the jump key (may differ from main).
  let jumpKeyPath = mainKeyPath;
  if (target.jumpPrivateKey && target.jumpPrivateKey !== target.privateKey) {
    jumpKeyPath = join(tmpDir, "ssh_jump_key");
    writeFileSync(jumpKeyPath, target.jumpPrivateKey, { mode: 0o600 });
    chmodSync(jumpKeyPath, 0o600);
  }
  const u = target.jumpUser || "root";
  const p = target.jumpPort || 22;
  const jumpOpts = `-i ${jumpKeyPath} -p ${p} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o LogLevel=ERROR`;

  // Jump ProxyCommand (optional) is the transport INTO the jumphost —
  // nested as the inner ssh's own ProxyCommand.
  if (jumpProxy.length > 0) {
    const inner = jumpProxy.replace(/'/g, "'\\''");
    const outer = `ssh ${jumpOpts} -o 'ProxyCommand=${inner}' -W %h:%p ${u}@${target.jumpHost}`;
    return ["-o", `ProxyCommand=${outer}`];
  }

  const proxy = `ssh ${jumpOpts} -W %h:%p ${u}@${target.jumpHost}`;
  return ["-o", `ProxyCommand=${proxy}`];
}

interface SshExecCallbacks {
  onStream: (line: string, seq: number) => void;
  onComplete: (success: boolean, payload?: any) => void;
}

/**
 * Resolve SSH connection details for a cluster.
 * Returns null if the cluster has no SSH key assigned.
 */
export async function getClusterSshTarget(clusterId: string): Promise<SshTarget | null> {
  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey) return null;

  // Fetch the jump key out-of-band (no Prisma relation) so we don't perturb
  // the dozens of existing `include: { sshKey: true }` call sites.
  let jumpPrivateKey: string | null = null;
  if (cluster.sshJumpKeyId && cluster.sshJumpKeyId !== cluster.sshKeyId) {
    const jumpKey = await prisma.sshKey.findUnique({ where: { id: cluster.sshJumpKeyId } });
    jumpPrivateKey = jumpKey?.privateKey ?? null;
  }

  return {
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
  };
}

/**
 * Execute a command on a remote host via SSH and stream output.
 * Returns a cleanup function and the child process.
 */
export function sshExec(
  target: SshTarget,
  command: string,
  callbacks: SshExecCallbacks,
): { proc: ChildProcess; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "aura-ssh-"));
  const keyPath = join(tmpDir, "ssh_key");

  writeFileSync(keyPath, target.privateKey, { mode: 0o600 });
  chmodSync(keyPath, 0o600);

  let seq = 0;

  const proc = spawn("ssh", [
    "-i", keyPath,
    "-p", String(target.port),
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=15",
    "-o", "BatchMode=yes",
    ...buildJumpArgs(target, tmpDir, keyPath),
    `${target.user}@${target.host}`,
    command,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line) callbacks.onStream(line, seq++);
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line && !line.startsWith("Warning: Permanently added")) {
        callbacks.onStream(`[stderr] ${line}`, seq++);
      }
    }
  });

  proc.on("close", (code) => {
    callbacks.onComplete(code === 0, { exitCode: code });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  proc.on("error", (err) => {
    callbacks.onComplete(false, { error: err.message });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const cleanup = () => {
    try { proc.kill(); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  return { proc, cleanup };
}

/**
 * Execute a command via SSH and return the result as a promise.
 * Collects all stdout into a string. Good for quick commands like `squeue`, `sinfo`.
 * For bastion mode: sends command via stdin with -tt, wraps with markers to extract output.
 */
export function sshExecSimple(
  target: SshTarget,
  command: string,
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aura-ssh-"));
    const keyPath = join(tmpDir, "ssh_key");

    writeFileSync(keyPath, target.privateKey, { mode: 0o600 });
    chmodSync(keyPath, 0o600);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    if (target.bastion) {
      // Bastion mode: use -tt and pipe commands via stdin with markers
      const marker = `__AURA_${Date.now()}__`;
      const wrappedCmd = `echo ${marker}_START; ${command}; echo ${marker}_EXIT_$?; exit\n`;

      const proc = spawn("ssh", [
        "-i", keyPath,
        "-p", String(target.port),
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", "ConnectTimeout=15",
        "-tt",
        ...buildJumpArgs(target, tmpDir, keyPath),
        `${target.user}@${target.host}`,
      ], { stdio: ["pipe", "pipe", "pipe"] });

      // Delay sending command to let the shell initialize
      setTimeout(() => {
        proc.stdin.write(wrappedCmd);
        proc.stdin.end();
      }, 1500);

      proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString()));
      proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));

      // Timeout after 30s
      const timeout = setTimeout(() => {
        proc.kill();
        rmSync(tmpDir, { recursive: true, force: true });
        resolve({ success: false, stdout: stdoutChunks.join(""), stderr: "Timeout", exitCode: null });
      }, 30000);

      proc.on("close", () => {
        clearTimeout(timeout);
        rmSync(tmpDir, { recursive: true, force: true });

        const fullOutput = stdoutChunks.join("");
        // A PTY echoes the command we piped in, which contains the START marker
        // literal. The real command output starts at the SECOND START occurrence
        // (when the remote shell actually evaluates `echo <marker>_START`).
        // Use lastIndexOf so we skip the echoed copy.
        const startNeedle = `${marker}_START`;
        const startIdx = fullOutput.lastIndexOf(startNeedle);
        const exitRegex = new RegExp(`${marker}_EXIT_(\\d+)`, "g");
        let exitMatch: RegExpExecArray | null = null;
        let m: RegExpExecArray | null;
        while ((m = exitRegex.exec(fullOutput)) !== null) {
          if (m.index > startIdx) { exitMatch = m; break; }
        }

        if (startIdx !== -1 && exitMatch) {
          const exitCode = parseInt(exitMatch[1]);
          const output = fullOutput
            .slice(startIdx + startNeedle.length, exitMatch.index)
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "")
            .trim();
          resolve({ success: exitCode === 0, stdout: output + "\n", stderr: stderrChunks.join(""), exitCode });
        } else {
          // Fallback: return raw output
          resolve({ success: false, stdout: fullOutput, stderr: stderrChunks.join(""), exitCode: null });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        rmSync(tmpDir, { recursive: true, force: true });
        resolve({ success: false, stdout: "", stderr: err.message, exitCode: null });
      });

      return;
    }

    // Normal SSH mode
    const proc = spawn("ssh", [
      "-i", keyPath,
      "-p", String(target.port),
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=15",
      "-o", "BatchMode=yes",
      ...buildJumpArgs(target, tmpDir, keyPath),
      `${target.user}@${target.host}`,
      command,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));

    proc.on("close", (code) => {
      rmSync(tmpDir, { recursive: true, force: true });
      resolve({
        success: code === 0,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode: code,
      });
    });

    proc.on("error", (err) => {
      rmSync(tmpDir, { recursive: true, force: true });
      resolve({
        success: false,
        stdout: "",
        stderr: err.message,
        exitCode: null,
      });
    });
  });
}

/**
 * Pipe a script to a remote host via SSH stdin.
 * Used for multi-line install/setup scripts.
 * For bastion mode: uses -tt and delays script delivery.
 */
export function sshExecScript(
  target: SshTarget,
  script: string,
  callbacks: SshExecCallbacks,
): { proc: ChildProcess; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "aura-ssh-"));
  const keyPath = join(tmpDir, "ssh_key");

  writeFileSync(keyPath, target.privateKey, { mode: 0o600 });
  chmodSync(keyPath, 0o600);

  let seq = 0;
  // Bastion mode sandwich — only forward output lines between these markers
  // to the caller. Strips the login MOTD, PS1/PS2 echoes, and any other
  // shell noise that leaks through the PTY.
  const BASTION_START = "__AURA_BASTION_OUT_START__";
  const BASTION_END = "__AURA_BASTION_OUT_END__";
  let bastionForwarding = !target.bastion; // non-bastion: always forward
  // When we see the END marker the script has fully run. Record that
  // *before* we tear down the ssh proc so proc.on("close") can report
  // success(true) even though we SIGKILL'd it — some bastions won't hang
  // up on a clean `exit` alone.
  let bastionScriptSucceeded = false;
  // Set when we see `[trace] bash exiting (status=N)`. null = never seen
  // (fall back to ssh exit code). 0 = script exited clean. Non-zero =
  // script failed, override ssh's 0 exit so the BackgroundTask doesn't
  // flip to "success" when the inner bash actually errored.
  let bastionTraceStatus: number | null = null;
  // Idle-timeout safety net: if we saw real script output and then nothing
  // for N seconds, assume the script finished but the bastion is holding
  // the ssh channel open. Force-kill so the UI doesn't sit on "Running"
  // until the overall watchdog. 30s covers legitimate silent stretches
  // during add-node (apt install, slurmd restart) without forcing the
  // user to wait the full 60s ssh watchdog.
  let bastionIdleTimer: NodeJS.Timeout | null = null;
  const bastionIdleMs = parseInt(process.env.AURA_BASTION_IDLE_MS ?? "30000", 10);
  const armBastionIdleKill = () => {
    if (!target.bastion) return;
    if (bastionIdleTimer) clearTimeout(bastionIdleTimer);
    bastionIdleTimer = setTimeout(() => {
      bastionScriptSucceeded = true; // we had real output, treat as success
      try { proc.stdin.end(); } catch {}
      try { proc.kill("SIGKILL"); } catch {}
    }, bastionIdleMs);
  };

  const sshArgs = [
    "-i", keyPath,
    "-p", String(target.port),
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=15",
  ];

  if (target.bastion) {
    sshArgs.push("-tt");
  } else {
    sshArgs.push("-o", "BatchMode=yes");
  }

  // ProxyJump hop (if configured on the cluster). Pushed *before* the
  // user@host target so ssh interprets it as a global option.
  for (const a of buildJumpArgs(target, tmpDir, keyPath)) sshArgs.push(a);

  sshArgs.push(`${target.user}@${target.host}`);

  if (!target.bastion) {
    sshArgs.push("bash -s");
  }

  const proc = spawn("ssh", sshArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (target.bastion) {
    // Bastion mode: encode script as base64, upload via ONE heredoc, decode,
    // execute.
    //
    // Why not hundreds of `echo` commands:
    //   The bastion runs over a pseudo-TTY with canonical mode + local echo.
    //   Writing hundreds of short `echo "..."` commands causes (a) the TTY
    //   to echo every line back into the log (massive noise), and (b)
    //   characters to get dropped when we outpace the line discipline —
    //   e.g. "chmod" arrives as "<hmod", the decoded script is corrupt,
    //   and bash dies with "unexpected EOF while looking for matching '".
    //
    //   `cat > FILE <<'AURA_B64_EOF'` tells the shell to accept every line
    //   that follows verbatim into FILE until it sees the delimiter on a
    //   line by itself — no per-line parsing. `stty -echo -icanon` before
    //   it turns off the PTY echo + cooked-mode buffering that causes the
    //   noise and the truncation.
    const b64 = Buffer.from(script).toString("base64");
    const b64Lines = b64.match(/.{1,76}/g) ?? [b64];
    const remoteB64 = "/tmp/.aura-run.b64";
    const remoteFile = "/tmp/.aura-run.sh";

    const fullCmd = [
      // stty -echo silences the TTY echoing our input back into the log.
      // Do NOT also disable -icanon — some bastion PTYs read input
      // byte-by-byte in non-canonical mode and end up waiting forever
      // for input that already arrived, stalling the `exit` command and
      // stranding the ssh session open. Canonical mode is needed for
      // line-oriented shell input to work normally.
      `stty -echo 2>/dev/null || true`,
      `PS1='' PS2=''`,
      `cat > ${remoteB64} <<'AURA_B64_EOF'`,
      ...b64Lines,
      `AURA_B64_EOF`,
      // Markers bracket the actual script output so the onStream loop can
      // drop the welcome banner / PS1 / stty-echo before START and any
      // post-exit noise after END.
      `echo ${BASTION_START}`,
      `base64 -d < ${remoteB64} > ${remoteFile} && rm -f ${remoteB64} && chmod +x ${remoteFile} && bash ${remoteFile}`,
      `echo ${BASTION_END}`,
      `rm -f ${remoteFile} ${remoteB64}`,
      `exit`,
      ``,
    ].join("\n");

    // Throttle the stdin write: some bastion PTYs silently drop bytes when
    // we push several KB of base64 into them in one shot, producing a
    // truncated /tmp/.aura-run.sh and the classic "unexpected EOF while
    // looking for matching `"'" parse error at random lines. Writing in
    // small chunks with a brief gap lets the remote kernel tty buffer
    // drain between pushes. ~256 bytes every 10ms = ~25 KB/s, plenty for
    // our scripts.
    // Do NOT close stdin here — the remote PTY would see EOF before it
    // has time to execute the script.
    const CHUNK = parseInt(process.env.AURA_BASTION_CHUNK_BYTES ?? "256", 10);
    const GAP_MS = parseInt(process.env.AURA_BASTION_CHUNK_GAP_MS ?? "10", 10);
    let offset = 0;
    const pump = () => {
      if (offset >= fullCmd.length || proc.exitCode !== null) return;
      const end = Math.min(offset + CHUNK, fullCmd.length);
      try { proc.stdin.write(fullCmd.slice(offset, end)); } catch { return; }
      offset = end;
      if (offset < fullCmd.length) setTimeout(pump, GAP_MS);
    };
    pump();
  } else {
    proc.stdin.write(script);
    proc.stdin.end();
  }

  // Bastion mode inserts markers around the real script output. Flip
  // forwarding on when we see START, off when we see END, and drop the
  // marker lines themselves. Non-bastion short-circuits (bastionForwarding
  // was initialized true above).
  const maybeForward = (line: string, prefix = "") => {
    if (target.bastion) {
      // Trim whitespace AND CR — we need to compare the line exactly
      // against the marker so that TTY echoes of the input commands
      // (`echo __AURA_BASTION_OUT_START__`) do NOT trigger toggling.
      // Only the shell's actual echo output (`__AURA_BASTION_OUT_START__`
      // alone on a line) should count.
      const clean = line.replace(/\r/g, "").trim();
      if (clean === BASTION_START) { bastionForwarding = true; return; }
      if (clean === BASTION_END) {
        bastionForwarding = false;
        bastionScriptSucceeded = true;
        try { proc.stdin.end(); } catch {}
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
        return;
      }
      // Drop any line containing "echo __AURA_BASTION_..." — that's the
      // TTY echoing our own input commands back at us.
      if (clean.startsWith("echo " + BASTION_START) || clean.startsWith("echo " + BASTION_END)) return;
      if (!bastionForwarding) return;
      // Real script output — reset the idle-kill timer.
      armBastionIdleKill();
    }
    if (line) callbacks.onStream(prefix + line, seq++);
    // Our scripts set `trap '...echo "[trace] bash exiting (status=$ec)..."' EXIT`
    // so the trace line is a reliable "inner bash done" signal. When we see
    // it with status=0 we can tear down the ssh session immediately instead
    // of waiting on the bastion's END marker / idle fallback.
    if (target.bastion) {
      const clean = line.replace(/\r/g, "").trim();
      const m = clean.match(/\[trace\] bash exiting \(status=(\d+)\)/);
      if (m) {
        bastionTraceStatus = parseInt(m[1], 10);
        bastionScriptSucceeded = bastionTraceStatus === 0;
        try { proc.stdin.end(); } catch {}
        // Brief grace period so any final stdout the script emitted after
        // the trap flushes through before we SIGKILL.
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 500);
      }
    }
  };

  proc.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) maybeForward(line);
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line && !line.startsWith("Warning: Permanently added")) {
        maybeForward(line, "[stderr] ");
      }
    }
  });

  // Hard cap so a wedged SSH connection (controller dropped, stuck command,
  // dnsmasq blackhole) doesn't hang an API request forever. Long-running
  // tasks (bootstrap, package installs) own their own task system and don't
  // await this directly, so 60s is fine as a default for short commands.
  const timeoutMs = parseInt(process.env.AURA_SSH_SCRIPT_TIMEOUT_MS ?? "60000", 10);
  let timedOut = false;
  let completed = false;
  const timer = setTimeout(() => {
    if (completed) return;
    timedOut = true;
    callbacks.onStream(`[stderr] ssh timed out after ${Math.round(timeoutMs / 1000)}s — killing process`, seq++);
    try { proc.kill("SIGKILL"); } catch {}
  }, timeoutMs);

  proc.on("close", (code) => {
    if (completed) return;
    completed = true;
    clearTimeout(timer);
    // Bastion path priority:
    //   1. If we saw the `[trace] bash exiting (status=N)` line, trust N
    //      absolutely — ssh's own exit code is misleading because the
    //      outer bastion shell's `exit` runs AFTER the inner bash traps,
    //      so ssh always reports 0 even when the script errored.
    //   2. Else, if we saw the END marker, treat as success.
    //   3. Else fall back to ssh exit code / watchdog.
    const success =
      bastionTraceStatus !== null ? bastionTraceStatus === 0
      : bastionScriptSucceeded ? true
      : (code === 0 && !timedOut);
    callbacks.onComplete(success, { exitCode: code, timedOut });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  proc.on("error", (err) => {
    if (completed) return;
    completed = true;
    clearTimeout(timer);
    callbacks.onComplete(false, { error: err.message });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const cleanup = () => {
    clearTimeout(timer);
    try { proc.kill(); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  return { proc, cleanup };
}
