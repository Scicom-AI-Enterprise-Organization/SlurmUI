import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/v1/admin/maintenance/truncate-job-output
 *
 * One-off cleanup: shrinks any oversized Job.output rows down to the last
 * 256 KB. Pairs with the watcher fix in lib/job-watcher.ts that now caps
 * the live capture at 256 KB — this endpoint retroactively trims rows
 * that were written before that fix landed.
 *
 * Idempotent: rows already <= 256 KB are skipped. Safe to re-run.
 *
 * Why under /api/v1 and not /api/admin: middleware.ts gates /api/admin/*
 * on the NextAuth session cookie, so a Bearer token there gets a 401
 * before the handler runs. /api/v1/* is excluded from that gate so
 * minted aura_* tokens work end-to-end.
 *
 * Auth: admin via session cookie OR Bearer `aura_*` token. Mint a token
 * at /profile/api-tokens.
 *
 * Usage (token):
 *   curl -X POST -H "Authorization: Bearer aura_…" \
 *     https://aura.example.com/api/v1/admin/maintenance/truncate-job-output
 *
 * Returns the before/after row counts and total bytes in Job.output.
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user || user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }

  const CAP_BYTES = 262144; // 256 KB — must match CAPTURE_CAP_BYTES in lib/job-watcher.ts.

  const summary = async () => {
    // Bind CAP_BYTES as ::int — Prisma sends JS numbers as bigint, but
    // Postgres `right(text, int)` and `length(text) > int` are int4 only,
    // and PG won't auto-cast bigint→int here. Explicit cast both sides.
    const rows = await prisma.$queryRaw<Array<{
      oversized: bigint;
      total_bytes: bigint;
      max_bytes: bigint;
      avg_bytes: number;
    }>>`
      SELECT
        count(*) FILTER (WHERE length(output) > ${CAP_BYTES}::int)::bigint AS oversized,
        COALESCE(sum(length(output)), 0)::bigint                            AS total_bytes,
        COALESCE(max(length(output)), 0)::bigint                            AS max_bytes,
        COALESCE(avg(length(output)), 0)::float                             AS avg_bytes
      FROM "Job"
      WHERE output IS NOT NULL
    `;
    const r = rows[0];
    return {
      oversizedRows: Number(r.oversized),
      totalBytes: Number(r.total_bytes),
      largestRowBytes: Number(r.max_bytes),
      avgRowBytes: Math.round(r.avg_bytes),
    };
  };

  const before = await summary();

  // Trim oversized rows in-place. right(output, N) keeps the last N
  // characters — same intent as `tail -c` on the file. ::int cast for
  // the same Prisma-bigint-vs-PG-int reason as above.
  const trimmed = await prisma.$executeRaw`
    UPDATE "Job"
    SET output = right(output, ${CAP_BYTES}::int)
    WHERE output IS NOT NULL
      AND length(output) > ${CAP_BYTES}::int
  `;

  const after = await summary();

  // VACUUM reclaims TOAST disk space the old big values were using. Can't
  // run inside an implicit transaction — Prisma's $executeRawUnsafe with
  // VACUUM works because Prisma issues each $executeRaw as its own
  // statement on the connection. Don't gate the response on it; if VACUUM
  // can't run (e.g. autovacuum is already busy on the table), the trim
  // still succeeded and the space will be reclaimed eventually.
  let vacuumed = false;
  try {
    await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) "Job"`);
    vacuumed = true;
  } catch {
    // ignore — autovacuum will catch up
  }

  return NextResponse.json({
    ok: true,
    capBytes: CAP_BYTES,
    rowsTrimmed: Number(trimmed),
    vacuumed,
    before,
    after,
  });
}
