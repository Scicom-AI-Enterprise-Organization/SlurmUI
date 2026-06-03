import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { GPU_PROVIDER_KINDS, testGpuProviderKey } from "@/lib/gpu-provider";

// What the browser is allowed to see — the raw API key never leaves the server.
const PUBLIC_SELECT = {
  id: true,
  name: true,
  kind: true,
  apiKeyLast4: true,
  accountEmail: true,
  validatedAt: true,
  createdAt: true,
} as const;

// GET /api/admin/gpu-providers — list GPU providers (without API key)
export async function GET(req: NextRequest) {
  const apiUser = await getApiUser(req);
  if (!apiUser || apiUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const providers = await prisma.gpuProvider.findMany({
    select: PUBLIC_SELECT,
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(providers);
}

// POST /api/admin/gpu-providers — create a provider. The key is verified
// against the provider's API before anything is stored.
export async function POST(req: NextRequest) {
  const apiUser = await getApiUser(req);
  if (!apiUser || apiUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { name, kind = "runpod", apiKey } = await req.json();

  if (!name || typeof name !== "string" || name.trim() === "") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }
  if (!GPU_PROVIDER_KINDS.includes(kind)) {
    return NextResponse.json({ error: `kind must be one of: ${GPU_PROVIDER_KINDS.join(", ")}` }, { status: 400 });
  }

  const existing = await prisma.gpuProvider.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return NextResponse.json({ error: `GPU provider "${name}" already exists` }, { status: 409 });
  }

  const trimmedKey = apiKey.trim();
  const test = await testGpuProviderKey(kind, trimmedKey);
  if (!test.ok) {
    return NextResponse.json({ error: `Connection test failed: ${test.message}` }, { status: 422 });
  }

  const provider = await prisma.gpuProvider.create({
    data: {
      name: name.trim(),
      kind,
      apiKey: trimmedKey,
      apiKeyLast4: trimmedKey.slice(-4),
      accountId: test.accountId ?? null,
      accountEmail: test.accountEmail ?? null,
      validatedAt: new Date(),
    },
    select: PUBLIC_SELECT,
  });

  await logAudit({
    action: "gpu_provider.create",
    entity: "GpuProvider",
    entityId: provider.id,
    metadata: { name: provider.name, kind: provider.kind },
  });

  return NextResponse.json(provider, { status: 201 });
}
