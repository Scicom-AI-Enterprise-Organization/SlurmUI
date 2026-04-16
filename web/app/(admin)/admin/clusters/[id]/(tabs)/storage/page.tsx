import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { StorageTab } from "@/components/cluster/storage-tab";
import { RequiresBootstrap } from "@/components/cluster/requires-nodes";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function StoragePage({ params }: PageProps) {
  const { id } = await params;
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) notFound();

  if (cluster.status !== "ACTIVE") return <RequiresBootstrap />;

  const config = cluster.config as Record<string, unknown>;
  const storageMounts = (config.storage_mounts ?? []) as any[];
  return <StorageTab clusterId={id} initialMounts={storageMounts} />;
}
