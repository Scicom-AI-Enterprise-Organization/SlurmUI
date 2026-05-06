import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runReconcile, loadGitOpsJobsConfig } from "@/lib/gitops-jobs";

// Manual trigger for the gitops-jobs reconciler. The cron tick in
// lib/gitops-jobs.ts runs the same code path on its interval; this route
// exists so admins can force a run from the UI without waiting.
//
// Intentionally does NOT gate on `cfg.enabled` — the toggle controls
// the background tick, not what an admin can do by hand. Forcing a
// reconcile from the UI must work even with the cron paused, e.g. for
// a one-off "see what would happen" check before flipping the toggle on.
export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = await loadGitOpsJobsConfig();
  if (!cfg.repoUrl) {
    return NextResponse.json({ error: "GitOps repoUrl is not configured" }, { status: 409 });
  }

  const task = await prisma.backgroundTask.create({
    data: { clusterId: "__global__", type: "gitops_jobs_reconcile" },
  });

  const appendLog = async (line: string) => {
    try {
      await prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${line + "\n"} WHERE id = ${task.id}`;
    } catch {}
  };

  (async () => {
    await appendLog(`[gitops] starting reconcile task ${task.id}`);
    let ok = true;
    try {
      await runReconcile((line) => { appendLog(line); });
    } catch (err) {
      ok = false;
      await appendLog(`[error] ${err instanceof Error ? err.message : "Unknown"}`);
    }
    await prisma.backgroundTask.update({
      where: { id: task.id },
      data: { status: ok ? "success" : "failed", completedAt: new Date() },
    }).catch(() => {});
  })();

  return NextResponse.json({ taskId: task.id });
}
