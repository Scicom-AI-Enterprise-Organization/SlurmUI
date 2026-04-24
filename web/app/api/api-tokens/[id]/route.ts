/**
 * DELETE /api/api-tokens/:id — revoke a token owned by the session user.
 * Revocation is a soft-delete (sets `revokedAt`) so audit history remains
 * queryable; the getApiUser lookup refuses anything with a non-null revokedAt.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ id: string }> }

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const { id } = await params;
  const row = await prisma.apiToken.findUnique({ where: { id } });
  if (!row || row.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.revokedAt) return NextResponse.json({ ok: true, alreadyRevoked: true });

  await prisma.apiToken.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
