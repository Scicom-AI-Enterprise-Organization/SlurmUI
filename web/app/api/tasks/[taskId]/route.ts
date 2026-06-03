import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

interface RouteParams {
  params: Promise<{ taskId: string }>;
}

// GET /api/tasks/[taskId] — get task status and logs
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { taskId } = await params;
  const apiUser = await getApiUser(req);

  if (!apiUser || apiUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const task = await prisma.backgroundTask.findUnique({ where: { id: taskId } });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  return NextResponse.json(task);
}
