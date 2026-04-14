import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { spawn } from "child_process";

interface RouteParams {
  params: Promise<{ token: string }>;
}

// GET /api/install/[token]/playbooks — serve ansible playbooks as .tar.gz
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

  const playbooksDir = process.env.ANSIBLE_PLAYBOOKS_DIR;
  if (!playbooksDir) {
    return NextResponse.json({ error: "ANSIBLE_PLAYBOOKS_DIR not configured" }, { status: 503 });
  }

  // Stream the directory as a gzip-compressed tarball.
  const webStream = new ReadableStream({
    start(controller) {
      // tar czf - -C <dir> . streams the directory contents to stdout
      const tar = spawn("tar", ["czf", "-", "-C", playbooksDir, "."]);

      tar.stdout.on("data", (chunk: Buffer) => controller.enqueue(chunk));
      tar.stdout.on("end", () => controller.close());
      tar.on("error", (err) => controller.error(err));
      tar.stderr.on("data", () => {}); // suppress stderr noise
    },
  });

  return new Response(webStream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": "attachment; filename=aura-playbooks.tar.gz",
      "Cache-Control": "no-store",
    },
  });
}
