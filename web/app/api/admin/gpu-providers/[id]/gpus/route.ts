import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { listRunPodGpuTypes } from "@/lib/gpu-provider";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/admin/gpu-providers/[id]/gpus — live GPU catalogue (stock +
// pricing) from the provider. Proxied server-side so the API key stays out
// of the browser.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const apiUser = await getApiUser(req);
  if (!apiUser || apiUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  const provider = await prisma.gpuProvider.findUnique({ where: { id } });
  if (!provider) {
    return NextResponse.json({ error: "GPU provider not found" }, { status: 404 });
  }
  if (provider.kind !== "runpod") {
    return NextResponse.json({ error: `GPU listing not supported for kind "${provider.kind}"` }, { status: 400 });
  }

  try {
    const gpus = await listRunPodGpuTypes(provider.apiKey);
    return NextResponse.json(gpus);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to fetch GPU types" }, { status: 502 });
  }
}
