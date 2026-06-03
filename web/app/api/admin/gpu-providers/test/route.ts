import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { GPU_PROVIDER_KINDS, testGpuProviderKey } from "@/lib/gpu-provider";

// POST /api/admin/gpu-providers/test — pre-create connection check for a raw
// API key (the add form's "Test connection" button). Nothing is stored.
export async function POST(req: NextRequest) {
  const apiUser = await getApiUser(req);
  if (!apiUser || apiUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { kind = "runpod", apiKey } = await req.json();

  if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }
  if (!GPU_PROVIDER_KINDS.includes(kind)) {
    return NextResponse.json({ error: `kind must be one of: ${GPU_PROVIDER_KINDS.join(", ")}` }, { status: 400 });
  }

  const result = await testGpuProviderKey(kind, apiKey.trim());
  return NextResponse.json(result);
}
