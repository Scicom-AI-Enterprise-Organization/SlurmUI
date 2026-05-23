/**
 * Shared helper for the synchronous /api/v1/* wrappers.
 *
 * The underlying UI endpoints all return `{ taskId }` immediately and run
 * the heavy work in a BackgroundTask the UI then polls. For CLI / scripted
 * use we want one HTTP round-trip that returns when the task finishes,
 * with the full log inline. This helper centralises that polling.
 */
import { prisma } from "@/lib/prisma";

export interface PollResult {
  kind: "task";
  taskId: string;
  status: "success" | "failed";
  logs: string;
  durationMs: number;
}

export interface PollHttpError {
  kind: "http-error";
  status: number;
  payload: unknown;
}

/**
 * Forward a request to an internal endpoint, expect a `{ taskId }` body
 * back, then poll the matching BackgroundTask row until it leaves the
 * "running" state.
 *
 * The `Authorization` header is propagated so the inner endpoint can
 * re-authenticate via getApiUser (after our `auth() → getApiUser` swap,
 * every shared endpoint accepts Bearer tokens).
 */
export async function forwardAndPoll(opts: {
  innerUrl: string;
  method: "POST" | "DELETE" | "PUT";
  authHeader: string;
  body?: unknown;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<PollResult | PollHttpError> {
  const init: RequestInit = {
    method: opts.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: opts.authHeader,
    },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const inner = await fetch(opts.innerUrl, init);
  let payload: any = {};
  try { payload = await inner.json(); } catch {}

  if (!inner.ok || !payload?.taskId) {
    return { kind: "http-error", status: inner.status, payload };
  }

  const taskId: string = payload.taskId;
  const start = Date.now();
  const deadline = start + (opts.timeoutMs ?? 30 * 60 * 1000);
  const interval = opts.pollIntervalMs ?? 2000;

  let task = await prisma.backgroundTask.findUnique({ where: { id: taskId } });
  while (task && task.status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    task = await prisma.backgroundTask.findUnique({ where: { id: taskId } });
  }
  if (!task) {
    return { kind: "http-error", status: 500, payload: { error: "Task disappeared" } };
  }

  return {
    kind: "task",
    taskId,
    status: task.status === "success" ? "success" : "failed",
    logs: task.logs ?? "",
    durationMs: Date.now() - start,
  };
}

export function v1Url(req: Request, path: string): string {
  // We always loop back through 127.0.0.1 because the request originated
  // from this server. Honours PORT in case Next was started on a
  // non-default port.
  return `http://127.0.0.1:${process.env.PORT ?? 3000}${path}`;
}
