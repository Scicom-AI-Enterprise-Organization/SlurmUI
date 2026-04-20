import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { generateInviteToken } from "@/lib/invite";

// GET — list pending + used invites (admin only). POST — create a new one.

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const invites = await prisma.invite.findMany({
    orderBy: { createdAt: "desc" },
    include: { createdBy: { select: { email: true, name: true } } },
  });
  // Never return raw tokens after creation — admins already copied them once.
  return NextResponse.json(
    invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt,
      usedAt: i.usedAt,
      createdAt: i.createdAt,
      createdBy: i.createdBy,
      tokenPreview: `${i.token.slice(0, 6)}…`,
    }))
  );
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as {
    email?: string; role?: "ADMIN" | "VIEWER"; expiresInHours?: number;
  };
  const role = body.role ?? "VIEWER";
  if (role !== "ADMIN" && role !== "VIEWER") {
    return NextResponse.json({ error: "Invalid role — must be ADMIN or VIEWER" }, { status: 400 });
  }
  const email = body.email?.toLowerCase().trim() || null;
  if (email) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: "A user with that email already exists" },
        { status: 409 }
      );
    }
  }
  const hours = Math.max(1, Math.min(24 * 30, body.expiresInHours ?? 24));
  const token = generateInviteToken();

  const invite = await prisma.invite.create({
    data: {
      token,
      email,
      role,
      createdById: session.user.id,
      expiresAt: new Date(Date.now() + hours * 3600 * 1000),
    },
  });

  await logAudit({
    action: "invite.create",
    entity: "Invite",
    entityId: invite.id,
    metadata: { role, email, expiresInHours: hours },
  });

  // Only moment we hand the raw token back. The admin must copy the link now.
  return NextResponse.json({ id: invite.id, token, role, email, expiresAt: invite.expiresAt });
}
