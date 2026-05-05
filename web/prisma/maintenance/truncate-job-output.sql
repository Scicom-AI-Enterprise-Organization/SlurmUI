-- One-off maintenance: shrink any oversized Job.output rows down to the
-- last 256 KB.
--
-- Why: lib/job-watcher.ts used to capture every byte of stdout for the
-- lifetime of a job, then write the whole thing to Job.output every 2s.
-- A single vLLM job with debug logging could leave hundreds of MB sitting
-- in this column, and any unselected `prisma.job.findUnique` would then
-- drag that into Node memory on every request — leading to heap OOM in
-- production. The watcher now bounds itself to 256 KB; this script
-- retroactively trims pre-existing rows so old data can't keep biting.
--
-- Idempotent: rows already <= 256 KB are skipped.
--
-- Run (dev):
--   docker exec -i scicom-aura-postgres-1 psql -U aura -d aura \
--     < web/prisma/maintenance/truncate-job-output.sql
--
-- Run (prod): pipe into your prod psql the same way.

\echo === BEFORE ===
SELECT
  count(*) FILTER (WHERE length(output) > 262144)         AS oversized_rows,
  pg_size_pretty(sum(length(output))::bigint)             AS total_output_bytes,
  pg_size_pretty(max(length(output))::bigint)             AS largest_row,
  pg_size_pretty(avg(length(output))::bigint)             AS avg_row
FROM "Job"
WHERE output IS NOT NULL;

BEGIN;

UPDATE "Job"
SET output = right(output, 262144)
WHERE output IS NOT NULL
  AND length(output) > 262144;

COMMIT;

\echo === AFTER ===
SELECT
  count(*) FILTER (WHERE length(output) > 262144)         AS oversized_rows,
  pg_size_pretty(sum(length(output))::bigint)             AS total_output_bytes,
  pg_size_pretty(max(length(output))::bigint)             AS largest_row,
  pg_size_pretty(avg(length(output))::bigint)             AS avg_row
FROM "Job"
WHERE output IS NOT NULL;

-- VACUUM reclaims the disk space TOAST was holding for the old big values.
-- Outside the transaction since VACUUM can't run inside BEGIN/COMMIT.
VACUUM (ANALYZE) "Job";
