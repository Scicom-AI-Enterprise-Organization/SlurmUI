import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sendTest, AlertChannel } from "@/lib/alerts";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const ch = await req.json() as AlertChannel;
  if (!ch || !ch.url) return NextResponse.json({ error: "url required" }, { status: 400 });
  const result = await sendTest(ch);
  return NextResponse.json(result);
}
