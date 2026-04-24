/**
 * Per-user API token management. Backs the /profile/api-tokens UI.
 *
 *   GET  /api/api-tokens          — list this user's tokens (no raw token,
 *                                    only prefix + metadata)
 *   POST /api/api-tokens          — create a new token. Raw token is returned
 *                                    ONCE in the response body; after that it's
 *                                    unrecoverable. Body: { name }
 *
 * Session-authenticated only (cookie). Bearer-authenticated callers can't
 * mint more tokens to avoid recursion / privilege surprises.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api-auth";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const tokens = await prisma.apiToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  });
  return NextResponse.json({ tokens });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  let body: { name?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "`name` is required" }, { status: 400 });
  if (name.length > 80) return NextResponse.json({ error: "`name` is too long (max 80)" }, { status: 400 });

  const { raw, prefix, hash } = generateToken();
  const token = await prisma.apiToken.create({
    data: { userId, name, prefix, tokenHash: hash },
    select: { id: true, name: true, prefix: true, createdAt: true },
  });

  // Raw token shown ONCE — never re-emitted by GET.
  return NextResponse.json({ token, raw }, { status: 201 });
}
