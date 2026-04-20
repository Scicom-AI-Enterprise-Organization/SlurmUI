import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

interface P { params: Promise<{ token: string }> }

// Public — returns whether a reset token is still valid + the email it
// targets, so the /reset/[token] page can confirm to the user who they're
// resetting for.
export async function GET(_req: NextRequest, { params }: P) {
  const { token } = await params;
  const row = await prisma.passwordResetToken.findUnique({
    where: { token },
    include: { user: { select: { email: true, name: true } } },
  });
  if (!row) return NextResponse.json({ error: "Invalid reset link" }, { status: 404 });
  if (row.usedAt) return NextResponse.json({ error: "This link has already been used" }, { status: 410 });
  if (row.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "This link has expired" }, { status: 410 });
  }
  return NextResponse.json({ email: row.user.email, name: row.user.name, expiresAt: row.expiresAt });
}

// Consume the token and set the new password. Atomic — the updateMany
// filter on usedAt=null makes the claim race-safe.
export async function POST(req: NextRequest, { params }: P) {
  const { token } = await params;
  const body = await req.json().catch(() => ({})) as { password?: string };
  const password = body.password ?? "";
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const row = await prisma.passwordResetToken.findUnique({ where: { token } });
  if (!row) return NextResponse.json({ error: "Invalid reset link" }, { status: 404 });
  if (row.usedAt) return NextResponse.json({ error: "This link has already been used" }, { status: 410 });
  if (row.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "This link has expired" }, { status: 410 });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.$transaction(async (tx) => {
    const claim = await tx.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claim.count !== 1) throw new Error("already used");
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
    // Invalidate any other outstanding reset links for the same user so
    // a leaked older token can't still be used after a successful reset.
    await tx.passwordResetToken.updateMany({
      where: { userId: row.userId, usedAt: null, id: { not: row.id } },
      data: { usedAt: new Date() },
    });
  });

  await logAudit({
    action: "user.password_reset_completed",
    entity: "User",
    entityId: row.userId,
    metadata: { tokenId: row.id },
  });

  return NextResponse.json({ ok: true });
}
