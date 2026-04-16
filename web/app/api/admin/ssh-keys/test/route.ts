import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple } from "@/lib/ssh-exec";

// POST /api/admin/ssh-keys/test — quick SSH connectivity test
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { sshKeyId, host, user, port } = await req.json();

  if (!sshKeyId || !host) {
    return NextResponse.json({ error: "sshKeyId and host are required" }, { status: 400 });
  }

  const sshKey = await prisma.sshKey.findUnique({ where: { id: sshKeyId } });
  if (!sshKey) {
    return NextResponse.json({ error: "SSH key not found" }, { status: 404 });
  }

  const result = await sshExecSimple(
    {
      host,
      user: user || "root",
      port: port || 22,
      privateKey: sshKey.privateKey,
    },
    "hostname && echo '__SSH_OK__'"
  );

  if (result.success && result.stdout.includes("__SSH_OK__")) {
    const hostname = result.stdout.split("\n")[0]?.trim() ?? "";
    return NextResponse.json({ success: true, hostname });
  }

  const errorMsg = result.stderr.trim()
    || result.stdout.trim()
    || `Exit code ${result.exitCode}`;

  return NextResponse.json({ success: false, error: errorMsg }, { status: 200 });
}
