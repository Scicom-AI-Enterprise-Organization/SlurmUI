import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runSync } from "@/lib/git-sync";

export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Git sync isn't scoped to a cluster — stash it under a reserved id so
  // the existing BackgroundTask polling infra works unchanged.
  const task = await prisma.backgroundTask.create({
    data: { clusterId: "__global__", type: "git_sync" },
  });

  const appendLog = async (line: string) => {
    try {
      await prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${line + "\n"} WHERE id = ${task.id}`;
    } catch {}
  };

  (async () => {
    await appendLog(`[sync] Starting git sync task ${task.id}`);
    let success = false;
    try {
      success = await runSync((line) => { appendLog(line); });
    } catch (err) {
      await appendLog(`[error] ${err instanceof Error ? err.message : "Unknown"}`);
    }
    await prisma.backgroundTask.update({
      where: { id: task.id },
      data: { status: success ? "success" : "failed", completedAt: new Date() },
    }).catch(() => {});
  })();

  return NextResponse.json({ taskId: task.id });
}
