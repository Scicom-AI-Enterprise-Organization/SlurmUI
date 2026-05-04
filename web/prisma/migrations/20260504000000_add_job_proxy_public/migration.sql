-- Per-job toggle that opens the /job-proxy/<clusterId>/<jobId>/* URL up
-- for unauthenticated access. Default false — opt-in only.

ALTER TABLE "Job"
  ADD COLUMN "proxyPublic" BOOLEAN NOT NULL DEFAULT false;
