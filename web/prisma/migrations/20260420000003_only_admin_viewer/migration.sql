-- Simplify to ADMIN + VIEWER only. Existing USER rows collapse to VIEWER
-- (read-only). The USER enum value is retained since Postgres can't drop
-- enum values without recreating the type; code no longer emits it.
UPDATE "User" SET "role" = 'VIEWER' WHERE "role" = 'USER';
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'VIEWER';
