-- Add ClusterType enum and the two new Cluster columns used by container
-- cluster support. BAREMETAL is the legacy/default behaviour so the
-- migration is fully backwards-compatible for existing rows.
--
-- allowCrossNodeScheduling is only meaningful when clusterType = CONTAINER;
-- for BAREMETAL clusters it is stored but ignored by the slurm.conf
-- template (multi-node is always allowed on baremetal).

CREATE TYPE "ClusterType" AS ENUM ('BAREMETAL', 'CONTAINER');

ALTER TABLE "Cluster"
  ADD COLUMN "clusterType" "ClusterType" NOT NULL DEFAULT 'BAREMETAL',
  ADD COLUMN "allowCrossNodeScheduling" BOOLEAN NOT NULL DEFAULT false;
