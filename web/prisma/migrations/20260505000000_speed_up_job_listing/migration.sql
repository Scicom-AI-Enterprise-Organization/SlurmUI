-- Composite indexes for the user-facing jobs listing endpoint
-- (/api/clusters/[id]/jobs). The default single-column clusterId index
-- forces a heap-sort step for `ORDER BY createdAt DESC LIMIT N`, which is
-- the page-load bottleneck on clusters with thousands of jobs. These
-- indexes let the planner do the filter + ordering in one walk.
--
-- IF NOT EXISTS guards make the migration safe to re-run on environments
-- where someone hand-rolled the index already.

CREATE INDEX IF NOT EXISTS "Job_clusterId_createdAt_idx"
  ON "Job"("clusterId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "Job_clusterId_userId_createdAt_idx"
  ON "Job"("clusterId", "userId", "createdAt" DESC);
