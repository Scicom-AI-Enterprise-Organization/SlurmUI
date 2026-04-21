import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Returns the latest BackgroundTask row for each gitops-jobs task type so
// the settings page can show "last reconcile" + "last mirror" logs without
// having to tail them live. Logs are truncated so we don't ship a huge blob
// every refresh.
const LOG_LIMIT = 16_000;

async function latest(type: string) {
  const task = await prisma.backgroundTask.findFirst({
    where: { type },
    orderBy: { createdAt: "desc" },
  });
  if (!task) return null;
  const logs = task.logs ?? "";
  const truncated = logs.length > LOG_LIMIT ? logs.slice(logs.length - LOG_LIMIT) : logs;
  return {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    logs: truncated,
    truncated: logs.length > LOG_LIMIT,
  };
}

// Cheap list for the history drawer — no logs, just the metadata the UI
// needs to render a row. The full log is loaded on click via ?taskId=.
// Filters by createdAt ∈ [from, to]. Hard limit of 500 rows so a pathological
// wide range can't OOM the browser; the UI can narrow the range if needed.
async function history(type: string, from: Date, to: Date) {
  const tasks = await prisma.backgroundTask.findMany({
    where: { type, createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { id: true, status: true, createdAt: true, completedAt: true },
  });
  return tasks;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ?taskId=… returns a single task's full (truncated-tail) log — used by
  // the history row-click to view an older run.
  const url = new URL(req.url);
  const taskId = url.searchParams.get("taskId");
  if (taskId) {
    const task = await prisma.backgroundTask.findUnique({ where: { id: taskId } });
    if (!task || (task.type !== "gitops_jobs_reconcile" && task.type !== "gitops_jobs_export_running")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const logs = task.logs ?? "";
    return NextResponse.json({
      id: task.id,
      status: task.status,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      logs: logs.length > LOG_LIMIT ? logs.slice(logs.length - LOG_LIMIT) : logs,
      truncated: logs.length > LOG_LIMIT,
    });
  }

  // Parse the time range. Default window: last 30 minutes. Callers can pass
  // `from` / `to` as ISO-8601 strings to widen the view.
  const now = Date.now();
  const toParam = url.searchParams.get("to");
  const fromParam = url.searchParams.get("from");
  const to = toParam ? new Date(toParam) : new Date(now);
  const from = fromParam ? new Date(fromParam) : new Date(now - 30 * 60 * 1000);
  if (isNaN(to.getTime()) || isNaN(from.getTime())) {
    return NextResponse.json({ error: "Invalid from/to timestamps" }, { status: 400 });
  }

  const [reconcile, exportRunning, reconcileHistory, exportHistory] = await Promise.all([
    latest("gitops_jobs_reconcile"),
    latest("gitops_jobs_export_running"),
    history("gitops_jobs_reconcile", from, to),
    history("gitops_jobs_export_running", from, to),
  ]);
  return NextResponse.json({
    reconcile,
    exportRunning,
    reconcileHistory,
    exportHistory,
    range: { from: from.toISOString(), to: to.toISOString() },
  });
}
