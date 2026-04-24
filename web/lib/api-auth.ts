/**
 * Bearer-token authentication for the /api/v1 public endpoints.
 *
 * Raw token layout: `aura_<base64url(24 random bytes)>` (33 chars total after
 * the prefix). We never store the raw token — only `sha256(raw)` lands in
 * `ApiToken.tokenHash`, mirroring the invite / password-reset pattern.
 *
 * Request flow:
 *   1. Extract `Authorization: Bearer <token>`.
 *   2. sha256 the token, look up `ApiToken` by hash (must not be revoked).
 *   3. Return the owning User; bump `lastUsedAt` (best-effort, unawaited
 *      so a slow DB doesn't delay the caller).
 *
 * UI (session-authenticated) requests don't need a Bearer — call
 * `requireUser(req)` which prefers the session cookie and only falls back
 * to Bearer if no session is present.
 */

import crypto from "crypto";
import type { NextRequest } from "next/server";
import { prisma } from "./prisma";
import { auth } from "./auth";

export interface ResolvedApiUser {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "VIEWER" | "USER";
  // How the caller authenticated — useful for audit metadata.
  via: "session" | "token";
  // Set only for token auth.
  tokenId?: string;
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function generateToken(): { raw: string; prefix: string; hash: string } {
  // 24 random bytes → 32 chars of base64url. Prefix makes it obvious what
  // kind of secret leaked in logs / grep.
  const bytes = crypto.randomBytes(24);
  const b64u = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const raw = `aura_${b64u}`;
  return { raw, prefix: raw.slice(0, 12), hash: hashToken(raw) };
}

function extractBearer(req: NextRequest | Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function resolveToken(raw: string): Promise<ResolvedApiUser | null> {
  const row = await prisma.apiToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { user: { select: { id: true, email: true, name: true, role: true } } },
  });
  if (!row) return null;
  if (row.revokedAt) return null;
  // Bump lastUsedAt out-of-band — don't block the request on a DB write.
  prisma.apiToken.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {});
  return {
    id: row.user.id,
    email: row.user.email,
    name: row.user.name,
    role: row.user.role,
    via: "token",
    tokenId: row.id,
  };
}

/**
 * Returns the authenticated user for an API request. Prefers the NextAuth
 * session (UI path) and falls back to Bearer token (API path). Returns
 * null if neither authenticates.
 */
export async function getApiUser(req: NextRequest | Request): Promise<ResolvedApiUser | null> {
  // Session cookie path — the same code backs both UI and API, so a logged-in
  // admin hitting /api/v1 from the browser still works.
  try {
    const session = await auth();
    if (session?.user) {
      return {
        id: (session.user as any).id ?? "",
        email: session.user.email ?? "",
        name: session.user.name ?? null,
        role: ((session.user as any).role ?? "VIEWER") as "ADMIN" | "VIEWER" | "USER",
        via: "session",
      };
    }
  } catch {}

  const raw = extractBearer(req);
  if (!raw) return null;
  return resolveToken(raw);
}
