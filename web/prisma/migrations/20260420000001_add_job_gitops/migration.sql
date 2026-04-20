-- GitOps fields on Job. sourceName is unique per cluster so a manifest
-- corresponds to a single job lineage; sourceRef is "<path>@sha256:<hash>"
-- so the reconciler can detect content changes.
ALTER TABLE "Job" ADD COLUMN "sourceRef" TEXT;
ALTER TABLE "Job" ADD COLUMN "sourceName" TEXT;

CREATE UNIQUE INDEX "Job_clusterId_sourceName_key" ON "Job"("clusterId", "sourceName");
