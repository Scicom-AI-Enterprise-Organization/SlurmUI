import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { inviteExpired } from "@/lib/invite";

interface P { params: Promise<{ token: string }> }

// Public — no auth. Used by the /invite/[token] page to show role + locked
// email before the user submits the form. Returns only the bits the form
// needs; never exposes the creator or other invites.
export async function GET(_req: NextRequest, { params }: P) {
  const { token } = await params;
  const invite = await prisma.invite.findUnique({ where: { token } });
  if (!invite) return NextResponse.json({ error: "Invalid invite" }, { status: 404 });
  if (invite.usedAt) return NextResponse.json({ error: "This invite has already been used" }, { status: 410 });
  if (inviteExpired(invite.expiresAt)) {
    return NextResponse.json({ error: "This invite has expired" }, { status: 410 });
  }
  return NextResponse.json({
    role: invite.role,
    email: invite.email,
    expiresAt: invite.expiresAt,
  });
}
