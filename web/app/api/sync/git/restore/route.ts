import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runRestore } from "@/lib/git-sync";

export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const task = await prisma.backgroundTask.create({
    data: { clusterId: "__global__", type: "git_restore" },
  });

  const appendLog = async (line: string) => {
    try {
      await prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${line + "\n"} WHERE id = ${task.id}`;
    } catch {}
  };

  (async () => {
    await appendLog(`[restore] Starting git restore task ${task.id}`);
    let ok = false;
    try {
      const summary = await runRestore((line) => { appendLog(line); }, { confirm: true });
      await appendLog(`[restore] Summary: ${JSON.stringify(summary, null, 2)}`);
      ok = true;
    } catch (err) {
      await appendLog(`[error] ${err instanceof Error ? err.message : "Unknown"}`);
    }
    await prisma.backgroundTask.update({
      where: { id: task.id },
      data: { status: ok ? "success" : "failed", completedAt: new Date() },
    }).catch(() => {});
  })();

  return NextResponse.json({ taskId: task.id });
}
