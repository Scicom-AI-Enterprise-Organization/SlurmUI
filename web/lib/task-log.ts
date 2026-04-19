import { prisma } from "@/lib/prisma";

// Per-task in-process queue so concurrent appendLog() calls land in order.
// Without this, multiple `UPDATE ... SET logs = logs || $line` statements
// race in Postgres (still atomic individually but the wire-arrival order
// from the SSH stream is lost), producing the jumbled diagnose output.
const queues = new Map<string, Promise<unknown>>();

/**
 * Append a line to a BackgroundTask's `logs` column, serialized per taskId.
 * Always non-blocking from the caller's POV — but each call won't fire its
 * UPDATE until the previous one for the same task has resolved.
 */
export function appendTaskLog(taskId: string, line: string): Promise<void> {
  const prev = queues.get(taskId) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined) // never let one failed update block the chain
    .then(() =>
      prisma
        .$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${line + "\n"} WHERE id = ${taskId}`
        .then(() => undefined)
    );
  queues.set(taskId, next);
  // Garbage-collect when the chain settles to keep the map bounded.
  next.finally(() => {
    if (queues.get(taskId) === next) queues.delete(taskId);
  });
  return next;
}
