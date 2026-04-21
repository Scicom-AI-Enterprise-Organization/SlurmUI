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

  const { sshKeyId, host, user, port, jumpHost, jumpUser, jumpPort, jumpKeyId, proxyCommand, jumpProxyCommand } = await req.json();

  if (!sshKeyId || !host) {
    return NextResponse.json({ error: "sshKeyId and host are required" }, { status: 400 });
  }

  const sshKey = await prisma.sshKey.findUnique({ where: { id: sshKeyId } });
  if (!sshKey) {
    return NextResponse.json({ error: "SSH key not found" }, { status: 404 });
  }

  let jumpPrivateKey: string | null = null;
  if (jumpHost && jumpKeyId && jumpKeyId !== sshKeyId) {
    const jk = await prisma.sshKey.findUnique({ where: { id: jumpKeyId } });
    if (!jk) return NextResponse.json({ error: "Jump SSH key not found" }, { status: 404 });
    jumpPrivateKey = jk.privateKey;
  }

  const result = await sshExecSimple(
    {
      host,
      user: user || "root",
      port: port || 22,
      privateKey: sshKey.privateKey,
      jumpHost: jumpHost || null,
      jumpUser: jumpUser || null,
      jumpPort: jumpPort || null,
      jumpPrivateKey,
      proxyCommand: proxyCommand || null,
      jumpProxyCommand: jumpProxyCommand || null,
    },
    "hostname && echo '__SSH_OK__'"
  );

  if (result.success && result.stdout.includes("__SSH_OK__")) {
    // Pick the first non-empty, non-warning line as the hostname. Some ssh
    // versions still emit "Warning: Permanently added ..." to stdout when
    // running under a non-TTY spawn, polluting line 0.
    const hostname = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("Warning:") && l !== "__SSH_OK__") ?? "";
    return NextResponse.json({ success: true, hostname });
  }

  const errorMsg = result.stderr.trim()
    || result.stdout.trim()
    || `Exit code ${result.exitCode}`;

  return NextResponse.json({ success: false, error: errorMsg }, { status: 200 });
}
