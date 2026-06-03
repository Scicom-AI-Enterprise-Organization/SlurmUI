import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// DELETE /api/admin/gpu-providers/[id]
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const apiUser = await getApiUser(req);
  if (!apiUser || apiUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  const provider = await prisma.gpuProvider.findUnique({ where: { id } });
  if (!provider) {
    return NextResponse.json({ error: "GPU provider not found" }, { status: 404 });
  }

  await prisma.gpuProvider.delete({ where: { id } });

  await logAudit({
    action: "gpu_provider.delete",
    entity: "GpuProvider",
    entityId: id,
    metadata: { name: provider.name, kind: provider.kind },
  });

  return NextResponse.json({ deleted: true });
}
