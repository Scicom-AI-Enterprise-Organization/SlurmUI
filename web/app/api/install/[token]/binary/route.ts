import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createReadStream, statSync } from "fs";

interface RouteParams {
  params: Promise<{ token: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { token } = await params;

  const cluster = await prisma.cluster.findUnique({
    where: { installToken: token },
  });
  if (!cluster) return NextResponse.json({ error: "Invalid token" }, { status: 404 });
  if (cluster.installTokenUsedAt) return NextResponse.json({ error: "Token already used" }, { status: 410 });
  if (cluster.installTokenExpiresAt && cluster.installTokenExpiresAt < new Date()) {
    return NextResponse.json({ error: "Token expired" }, { status: 410 });
  }

  const binaryPath = process.env.AURA_AGENT_BINARY_SRC;
  if (!binaryPath) {
    return NextResponse.json({ error: "Agent binary not configured (AURA_AGENT_BINARY_SRC)" }, { status: 503 });
  }

  let stat;
  try {
    stat = statSync(binaryPath);
  } catch {
    return NextResponse.json({ error: "Agent binary not found on server" }, { status: 503 });
  }

  const nodeStream = createReadStream(binaryPath);
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => controller.enqueue(chunk));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new Response(webStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": "attachment; filename=aura-agent",
      "Cache-Control": "no-store",
    },
  });
}
