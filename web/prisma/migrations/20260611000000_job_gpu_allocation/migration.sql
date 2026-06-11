-- Allocation snapshot captured by the job watcher from `scontrol show job -d`
ALTER TABLE "Job" ADD COLUMN "nodeList" TEXT;
ALTER TABLE "Job" ADD COLUMN "gresDetail" TEXT;
ALTER TABLE "Job" ADD COLUMN "gpuIndices" TEXT;
