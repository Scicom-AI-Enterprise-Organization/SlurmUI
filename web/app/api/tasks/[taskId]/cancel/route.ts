import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cancelTask } from "@/lib/running-tasks";

interface RouteParams {
  params: Promise<{ taskId: string }>;
}

// POST /api/tasks/[taskId]/cancel — kill a running BackgroundTask's SSH process.
export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { taskId } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const task = await prisma.backgroundTask.findUnique({ where: { id: taskId } });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (task.status !== "running") {
    return NextResponse.json({ error: "Task is not running" }, { status: 409 });
  }

  const killed = cancelTask(taskId);

  // Append a note to the log. Status will be flipped to "failed" by the
  // process's onComplete handler once it exits; if the registry had no entry
  // (e.g. server restarted after task started), force-mark it failed here.
  await prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${"[aura] Cancel requested by user.\n"} WHERE id = ${taskId}`.catch(() => {});

  if (!killed) {
    await prisma.backgroundTask.update({
      where: { id: taskId },
      data: { status: "failed", completedAt: new Date() },
    }).catch(() => {});
  }

  return NextResponse.json({ cancelled: true, killed });
}
