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

  if (cluster.status === "PROVISIONING") return <RequiresBootstrap />;

  const config = cluster.config as Record<string, unknown>;
  const storageMounts = (config.storage_mounts ?? []) as any[];
  const nfsServers = (config.nfs_servers ?? []) as any[];
  const hostsEntries = (config.slurm_hosts_entries ?? []) as Array<{
    hostname: string;
    ip: string;
    user?: string;
    port?: number;
  }>;
  return (
    <StorageTab
      clusterId={id}
      initialMounts={storageMounts}
      initialNfsServers={nfsServers}
      nodes={hostsEntries}
    />
  );
}
