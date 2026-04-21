-- Optional raw ProxyCommand overrides — one for the primary ssh hop (to the
-- controller), one for the jump hop. Either/both can be set. When the host
-- ProxyCommand is set, jump fields are bypassed entirely.
ALTER TABLE "Cluster" ADD COLUMN "sshProxyCommand" TEXT;
ALTER TABLE "Cluster" ADD COLUMN "sshJumpProxyCommand" TEXT;
