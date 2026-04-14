import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createReadStream, statSync } from "fs";
import path from "path";

interface RouteParams {
  params: Promise<{ token: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { token } = await params;

  const cluster = await prisma.cluster.findUnique({
    where: { installToken: token },
  });
  if (!cluster) return NextResponse.json({ error: "Invalid token" }, { status: 404 });
  if (cluster.installTokenUsedAt) return NextResponse.json({ error: "Token already used" }, { status: 410 });
  if (cluster.installTokenExpiresAt && cluster.installTokenExpiresAt < new Date()) {
    return NextResponse.json({ error: "Token expired" }, { status: 410 });
  }

  // Detect requested arch — default to amd64 for backwards compat.
  const arch = req.nextUrl.searchParams.get("arch") ?? "amd64";
  if (arch !== "amd64" && arch !== "arm64") {
    return NextResponse.json({ error: "Unsupported arch. Use amd64 or arm64." }, { status: 400 });
  }

  // Support both old AURA_AGENT_BINARY_SRC (single binary) and new AURA_AGENT_BINARY_DIR.
  let binaryPath: string;
  const binaryDir = process.env.AURA_AGENT_BINARY_DIR;
  const binarySrc = process.env.AURA_AGENT_BINARY_SRC;

  if (binaryDir) {
    binaryPath = path.join(binaryDir, `aura-agent-${arch}`);
  } else if (binarySrc) {
    // Legacy: single binary — only serves whatever was built, ignore arch param.
    binaryPath = binarySrc;
  } else {
    return NextResponse.json({ error: "Agent binary not configured (AURA_AGENT_BINARY_DIR)" }, { status: 503 });
  }

  let stat;
  try {
    stat = statSync(binaryPath);
  } catch {
    return NextResponse.json({ error: `Agent binary not found on server (${arch})` }, { status: 503 });
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
      "Content-Disposition": `attachment; filename=aura-agent`,
      "Cache-Control": "no-store",
    },
  });
}
