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

  return {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
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
    "-o", "ConnectTimeout=15",
    "-o", "BatchMode=yes",
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
        "-o", "ConnectTimeout=15",
        "-tt",
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
      "-o", "ConnectTimeout=15",
      "-o", "BatchMode=yes",
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

  const sshArgs = [
    "-i", keyPath,
    "-p", String(target.port),
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=15",
  ];

  if (target.bastion) {
    sshArgs.push("-tt");
  } else {
    sshArgs.push("-o", "BatchMode=yes");
  }

  sshArgs.push(`${target.user}@${target.host}`);

  if (!target.bastion) {
    sshArgs.push("bash -s");
  }

  const proc = spawn("ssh", sshArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (target.bastion) {
    // Bastion mode: encode script as base64, decode on remote, execute.
    // Can't pipe large scripts through bastion stdin reliably.
    const b64 = Buffer.from(script).toString("base64");
    // Split base64 into 76-char lines for echo compatibility
    const b64Lines = b64.match(/.{1,76}/g) ?? [b64];
    const catBlock = b64Lines.map((l) => `echo "${l}"`).join("; ");
    const remoteFile = "/tmp/.aura-run.sh";

    const fullCmd = `(${catBlock}) | base64 -d > ${remoteFile} && chmod +x ${remoteFile} && bash ${remoteFile}; rm -f ${remoteFile}; exit\n`;

    setTimeout(() => {
      proc.stdin.write(fullCmd);
    }, 2000);
  } else {
    proc.stdin.write(script);
    proc.stdin.end();
  }

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
