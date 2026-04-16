import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import type { Session } from "next-auth";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function isAdmin(session: Session | null): boolean {
  return !!session?.user && (session.user as any).role === "ADMIN";
}

// DELETE /api/admin/ssh-keys/[id]
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  const key = await prisma.sshKey.findUnique({
    where: { id },
    include: { _count: { select: { clusters: true } } },
  });

  if (!key) {
    return NextResponse.json({ error: "SSH key not found" }, { status: 404 });
  }

  if (key._count.clusters > 0) {
    return NextResponse.json(
      { error: `Cannot delete: ${key._count.clusters} cluster(s) are using this key` },
      { status: 409 },
    );
  }

  await prisma.sshKey.delete({ where: { id } });

  await logAudit({
    action: "ssh_key.delete",
    entity: "SshKey",
    entityId: id,
    metadata: { name: key.name },
  });

  return NextResponse.json({ deleted: true });
}
