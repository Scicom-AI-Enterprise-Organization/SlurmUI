import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { inviteExpired } from "@/lib/invite";

interface P { params: Promise<{ token: string }> }

// Public — creates a new User from the invite, hashes the password, marks
// the invite as used. Atomic transaction so a race can't double-consume it.
export async function POST(req: NextRequest, { params }: P) {
  const { token } = await params;
  const body = await req.json().catch(() => ({})) as {
    email?: string; name?: string; password?: string;
  };

  const password = body.password ?? "";
  const name = body.name?.trim() || null;
  const submittedEmail = body.email?.toLowerCase().trim() ?? "";

  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }
  if (!submittedEmail) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  const invite = await prisma.invite.findUnique({ where: { token } });
  if (!invite) return NextResponse.json({ error: "Invalid invite" }, { status: 404 });
  if (invite.usedAt) return NextResponse.json({ error: "This invite has already been used" }, { status: 410 });
  if (inviteExpired(invite.expiresAt)) {
    return NextResponse.json({ error: "This invite has expired" }, { status: 410 });
  }
  if (invite.email && invite.email.toLowerCase() !== submittedEmail) {
    return NextResponse.json({ error: "This invite is locked to a different email" }, { status: 403 });
  }

  const existing = await prisma.user.findUnique({ where: { email: submittedEmail } });
  if (existing) {
    return NextResponse.json({ error: "An account with that email already exists" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  // Transaction: (1) create the user, (2) mark invite used with the new
  // user's id. Race-safe because the update filters on usedAt being null.
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email: submittedEmail,
        name,
        passwordHash,
        role: invite.role,
        // Synthetic keycloakId so the unique index stays populated.
        keycloakId: `local:${crypto.randomUUID()}`,
        emailVerified: new Date(),
      },
    });
    const claim = await tx.invite.updateMany({
      where: { id: invite.id, usedAt: null },
      data: { usedAt: new Date(), usedByUserId: u.id },
    });
    if (claim.count !== 1) {
      throw new Error("invite already consumed");
    }
    return u;
  });

  await logAudit({
    action: "invite.accept",
    entity: "User",
    entityId: user.id,
    metadata: { inviteId: invite.id, role: invite.role, email: submittedEmail },
  });

  return NextResponse.json({ ok: true, email: submittedEmail });
}
