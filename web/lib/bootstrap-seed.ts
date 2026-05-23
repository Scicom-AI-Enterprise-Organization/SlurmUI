/**
 * Post-bootstrap config seeding helpers.
 *
 * Bootstrap writes a working `slurm.conf` (NodeName + PartitionName), but
 * the UI reads from `cluster.config.slurm_partitions` to render the
 * Partitions tab and to populate the New Job form's partition dropdown.
 * Without these mirrored entries the user lands on "no default partition"
 * even though slurm itself has one. Call this once after a successful
 * bootstrap.
 */
import { prisma } from "@/lib/prisma";

interface SlurmPartition {
  name: string;
  default?: boolean;
  max_time?: string;
}

/**
 * If `cluster.config.slurm_partitions` is empty, seed it with the same
 * default partition the slurm.conf template wrote (`main`, default,
 * MaxTime=INFINITE). Returns `true` when it actually wrote, `false` when
 * the field was already populated.
 */
export async function seedDefaultPartition(clusterId: string): Promise<boolean> {
  const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } });
  if (!cluster) return false;
  const cfg = (cluster.config ?? {}) as Record<string, unknown>;
  const existing = (cfg.slurm_partitions ?? []) as SlurmPartition[];
  if (Array.isArray(existing) && existing.length > 0) return false;

  cfg.slurm_partitions = [
    {
      name: "main",
      // Slurm accepts `Nodes=ALL` as a wildcard meaning "every node
      // configured in this slurm.conf". Required so a re-bootstrap that
      // reads this seed back into the template doesn't fail on a missing
      // `partition.nodes` attribute (the template does
      // `partition.nodes | join(',')`). Admins can change this in the
      // Partitions tab once they have real node groupings.
      nodes: "ALL",
      default: true,
      max_time: "INFINITE",
    },
  ];
  await prisma.cluster.update({
    where: { id: clusterId },
    data: { config: cfg as never },
  });
  return true;
}
