import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/clusters/[id]/bootstrap/status — check if bootstrap is running
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const task = await prisma.backgroundTask.findFirst({
    where: { clusterId: id, type: "bootstrap" },
    orderBy: { createdAt: "desc" },
  });

  if (!task) {
    return NextResponse.json({ running: false });
  }

  return NextResponse.json({
    taskId: task.id,
    status: task.status,
    running: task.status === "running",
  });
}
