import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

interface P { params: Promise<{ id: string }> }

// DELETE — revoke (or hard-delete) an invite. Idempotent.
export async function DELETE(_req: NextRequest, { params }: P) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const existing = await prisma.invite.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: true });
  await prisma.invite.delete({ where: { id } });
  await logAudit({
    action: "invite.revoke",
    entity: "Invite",
    entityId: id,
    metadata: { role: existing.role, email: existing.email, wasUsed: !!existing.usedAt },
  });
  return NextResponse.json({ ok: true });
}
