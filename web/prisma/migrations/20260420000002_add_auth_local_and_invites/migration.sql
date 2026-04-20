-- Local-credentials auth: passwordHash null for Keycloak-only users.
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "User" ADD COLUMN "emailVerified" TIMESTAMP(3);

-- New role. Postgres enum ALTER requires a bare statement outside any
-- surrounding transaction block, hence the dedicated migration.
ALTER TYPE "UserRole" ADD VALUE 'VIEWER';

-- Single-use invite tokens.
CREATE TABLE "Invite" (
    "id"           TEXT NOT NULL,
    "token"        TEXT NOT NULL,
    "email"        TEXT,
    "role"         "UserRole" NOT NULL,
    "createdById"  TEXT NOT NULL,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "usedAt"       TIMESTAMP(3),
    "usedByUserId" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Invite_token_key" ON "Invite"("token");
CREATE INDEX "Invite_createdById_idx" ON "Invite"("createdById");
CREATE INDEX "Invite_expiresAt_idx" ON "Invite"("expiresAt");
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
