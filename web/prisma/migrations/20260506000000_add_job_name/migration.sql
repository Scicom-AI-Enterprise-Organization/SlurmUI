-- Add explicit name column to Job and backfill from the SBATCH directive
-- already inside the stored script. Used by the in-code uniqueness check
-- in lib/submit-job.ts so two active jobs on the same cluster can't share
-- a name.

ALTER TABLE "Job" ADD COLUMN "name" TEXT;

-- Backfill: extract the first `#SBATCH --job-name=<value>` or `-J <value>`
-- token. substring() with a POSIX regex returns the first capture group.
-- Anchored to a line start so we don't pick up `--job-name` text inside
-- a comment or another flag's value.
UPDATE "Job"
SET "name" = NULLIF(
  substring(
    "script" FROM '(?n)^[[:space:]]*#SBATCH[[:space:]]+(?:--job-name=|-J[[:space:]]+|-J=)([^[:space:]]+)'
  ),
  ''
)
WHERE "name" IS NULL;

-- Fast lookup for `WHERE clusterId = $1 AND name = $2` (the uniqueness
-- check on submit). NOT a UNIQUE index — legacy data may already have
-- duplicates and the runtime check is what enforces going forward.
CREATE INDEX "Job_clusterId_name_idx" ON "Job"("clusterId", "name");
