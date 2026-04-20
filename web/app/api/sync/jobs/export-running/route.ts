import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runExportRunning, loadGitOpsJobsConfig } from "@/lib/gitops-jobs";

// Push a snapshot of every PENDING/RUNNING job into <repo>/running/ as YAML.
// Unlike /reconcile this is a one-way mirror — the reconciler never reads the
// running/ folder, so exported snapshots can't trigger cancel+resubmit loops.
export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = await loadGitOpsJobsConfig();
  if (!cfg.repoUrl) {
    return NextResponse.json({ error: "Git Jobs repoUrl is not configured" }, { status: 409 });
  }

  const task = await prisma.backgroundTask.create({
    data: { clusterId: "__global__", type: "gitops_jobs_export_running" },
  });

  const appendLog = async (line: string) => {
    try {
      await prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${line + "\n"} WHERE id = ${task.id}`;
    } catch {}
  };

  (async () => {
    await appendLog(`[export] starting running-jobs export task ${task.id}`);
    let ok = true;
    try {
      await runExportRunning((line) => { appendLog(line); });
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
