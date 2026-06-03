import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { testGpuProviderKey } from "@/lib/gpu-provider";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/admin/gpu-providers/[id]/test — re-validate a stored provider's
// API key. Refreshes validatedAt / account info on success.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const apiUser = await getApiUser(req);
  if (!apiUser || apiUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  const provider = await prisma.gpuProvider.findUnique({ where: { id } });
  if (!provider) {
    return NextResponse.json({ error: "GPU provider not found" }, { status: 404 });
  }

  const result = await testGpuProviderKey(provider.kind, provider.apiKey);

  if (result.ok) {
    await prisma.gpuProvider.update({
      where: { id },
      data: {
        validatedAt: new Date(),
        accountId: result.accountId ?? provider.accountId,
        accountEmail: result.accountEmail ?? provider.accountEmail,
      },
    });
  }

  return NextResponse.json(result);
}
