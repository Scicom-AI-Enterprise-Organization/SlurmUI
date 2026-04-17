import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getLatestHealth } from "@/lib/health-monitor";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const snapshot = getLatestHealth(id);
  return NextResponse.json(snapshot ?? { pending: true });
}
