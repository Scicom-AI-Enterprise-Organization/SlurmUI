/**
 * In-process registry of cancellable BackgroundTask executions.
 *
 * sshExecScript returns a ChildProcess + cleanup fn. Apply routes register the
 * task here so a separate HTTP handler (or UI) can call `cancelTask(taskId)`
 * to kill the SSH process mid-run. The registry lives only in memory; a server
 * restart loses all registrations (and the SSH processes die with the server).
 */

import type { ChildProcess } from "child_process";

interface Entry {
  proc: ChildProcess;
  cleanup: () => void;
}

const tasks = new Map<string, Entry>();

export function registerRunningTask(taskId: string, entry: Entry): void {
  tasks.set(taskId, entry);
  // Auto-unregister when the process exits.
  entry.proc.on("close", () => tasks.delete(taskId));
  entry.proc.on("error", () => tasks.delete(taskId));
}

export function cancelTask(taskId: string): boolean {
  const entry = tasks.get(taskId);
  if (!entry) return false;
  try {
    entry.proc.kill("SIGTERM");
    // Fallback SIGKILL after 3s if still alive
    setTimeout(() => {
      try { entry.proc.kill("SIGKILL"); } catch {}
    }, 3000);
  } catch {}
  try { entry.cleanup(); } catch {}
  tasks.delete(taskId);
  return true;
}

export function isTaskRunning(taskId: string): boolean {
  return tasks.has(taskId);
}
