import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { StorageTab } from "@/components/cluster/storage-tab";
import { RequiresNodes } from "@/components/cluster/requires-nodes";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function StoragePage({ params }: PageProps) {
  const { id } = await params;
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) notFound();

  const config = cluster.config as Record<string, unknown>;
  const nodes = (config.slurm_hosts_entries ?? []) as any[];

  if (nodes.length === 0) return <RequiresNodes clusterId={id} />;

  const storageMounts = (config.storage_mounts ?? []) as any[];
  return <StorageTab clusterId={id} initialMounts={storageMounts} />;
}
