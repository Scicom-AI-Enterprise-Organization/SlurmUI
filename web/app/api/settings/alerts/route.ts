import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadChannels, saveChannels, AlertChannel } from "@/lib/alerts";
import { randomUUID } from "crypto";

export async function GET() {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(await loadChannels());
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { channels: AlertChannel[] };
  if (!Array.isArray(body.channels)) {
    return NextResponse.json({ error: "channels must be an array" }, { status: 400 });
  }

  // Normalize + validate each channel. Generate ids for new ones.
  const cleaned: AlertChannel[] = body.channels.map((c) => {
    const type = c.type === "slack" || c.type === "teams" || c.type === "generic" ? c.type : "generic";
    const url = (c.url ?? "").trim();
    const name = (c.name ?? "").trim();
    if (!name) throw new Error("channel name is required");
    if (!/^https?:\/\//.test(url)) throw new Error(`invalid URL for channel "${name}"`);
    return {
      id: c.id || randomUUID(),
      name,
      type,
      url,
      events: Array.isArray(c.events) ? c.events.map((e) => String(e).trim()).filter(Boolean) : [],
      clusters: Array.isArray(c.clusters) ? c.clusters.map((x) => String(x).trim()).filter(Boolean) : [],
      enabled: c.enabled !== false,
      createdAt: c.createdAt || new Date().toISOString(),
    };
  });

  try {
    await saveChannels(cleaned);
    return NextResponse.json(cleaned);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "save failed" },
      { status: 400 }
    );
  }
}
