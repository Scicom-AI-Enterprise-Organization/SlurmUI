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

  // Append the cancel note and flip the DB row to "failed" immediately.
  // Waiting for the proc's onComplete to update status leaves the UI stuck
  // on "Running…" for minutes when the remote is deep in an apt-get /
  // dpkg unpack (dpkg ignores SIGHUP until a quiescent point). Setting
  // status here makes the log-dialog poll see the terminal state next tick;
  // the SSH process still gets SIGTERM/SIGKILL via cancelTask so local
  // resources are reclaimed whenever it eventually exits.
  await prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${"[aura] Cancel requested by user.\n"} WHERE id = ${taskId}`.catch(() => {});
  await prisma.backgroundTask.update({
    where: { id: taskId },
    data: { status: "failed", completedAt: new Date() },
  }).catch(() => {});

  return NextResponse.json({ cancelled: true, killed });
}
