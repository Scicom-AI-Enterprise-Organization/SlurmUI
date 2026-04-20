-- Add ProxyJump fields. All nullable so existing clusters are unaffected.
-- sshJumpKeyId references SshKey.id loosely (no FK constraint) — the ssh-exec
-- helpers look it up by ID when a jump hop is configured.
ALTER TABLE "Cluster"
  ADD COLUMN "sshJumpHost" TEXT,
  ADD COLUMN "sshJumpUser" TEXT DEFAULT 'root',
  ADD COLUMN "sshJumpPort" INTEGER DEFAULT 22,
  ADD COLUMN "sshJumpKeyId" TEXT;
