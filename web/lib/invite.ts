import { randomBytes } from "crypto";

export function generateInviteToken(): string {
  // 32 bytes → 43-char base64url. Single-use, stored verbatim in the DB.
  return randomBytes(32).toString("base64url");
}

export function inviteExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() < Date.now();
}
