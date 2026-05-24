import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Apply sensible connection-pool defaults to the configured DATABASE_URL.
 *
 * Prisma's default pool size is `num_physical_cpus * 2 + 1`. In a 1-CPU
 * container that's 3 — way too small for this app's mix of:
 *   - per-request DB calls (Next.js API routes),
 *   - the heartbeat / health-probe tickers (one query each per cluster
 *     per tick — easily 10+ concurrent on a busy multi-cluster deploy),
 *   - background sync jobs (gitops, slurmctld reconcile, audit writes).
 *
 * The default 10s pool_timeout then drops every overflowing query with
 * "Timed out fetching a new connection from the connection pool" and the
 * UI shows a half-rendered cluster list. Override both via query params
 * (no schema or migration change needed) when the operator hasn't set
 * them explicitly — operator intent always wins.
 */
const DEFAULT_CONNECTION_LIMIT = parseInt(process.env.PRISMA_CONNECTION_LIMIT ?? "15", 10);
const DEFAULT_POOL_TIMEOUT = parseInt(process.env.PRISMA_POOL_TIMEOUT ?? "30", 10);

function withPoolDefaults(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (!u.searchParams.has("connection_limit")) {
      u.searchParams.set("connection_limit", String(DEFAULT_CONNECTION_LIMIT));
    }
    if (!u.searchParams.has("pool_timeout")) {
      u.searchParams.set("pool_timeout", String(DEFAULT_POOL_TIMEOUT));
    }
    return u.toString();
  } catch {
    // Non-URL DATABASE_URL (e.g. unset / placeholder) — pass through and
    // let Prisma surface the real connection error rather than masking
    // it with a parse error here.
    return rawUrl;
  }
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl: withPoolDefaults(process.env.DATABASE_URL),
    log: process.env.PRISMA_LOG_QUERIES === "1"
      ? ["query", "error", "warn"]
      : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
