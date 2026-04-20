import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { generateInviteToken } from "@/lib/invite";

interface P { params: Promise<{ id: string }> }

// Admin-only. Generates a single-use password-reset link for the target
// user. The raw token is returned exactly once so the admin can deliver it
// out-of-band; after that, only the first 6 chars are ever surfaced.
//
// Only works for local (non-Keycloak) users — Keycloak passwords live in
// Keycloak and we never touch them.
export async function POST(_req: NextRequest, { params }: P) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (target.keycloakId && !target.keycloakId.startsWith("local:")) {
    return NextResponse.json(
      { error: "This user signs in via Keycloak — reset their password there." },
      { status: 400 }
    );
  }

  const token = generateInviteToken();
  // 1 hour expiry. Password-reset tokens bypass auth so we keep them short.
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  const reset = await prisma.passwordResetToken.create({
    data: { token, userId: id, createdById: session.user.id, expiresAt },
  });

  await logAudit({
    action: "user.password_reset_link_issued",
    entity: "User",
    entityId: id,
    metadata: { email: target.email, tokenId: reset.id, expiresAt },
  });

  return NextResponse.json({ token, expiresAt });
}
