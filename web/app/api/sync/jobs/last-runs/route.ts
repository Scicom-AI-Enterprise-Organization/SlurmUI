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

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const [reconcile, exportRunning] = await Promise.all([
    latest("gitops_jobs_reconcile"),
    latest("gitops_jobs_export_running"),
  ]);
  return NextResponse.json({ reconcile, exportRunning });
}
