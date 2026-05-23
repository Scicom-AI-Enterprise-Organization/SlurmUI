import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { IntegrationsTab } from "@/components/cluster/integrations-tab";
import { listTrackersFromConfig } from "@/lib/experiment-trackers";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function IntegrationsPage({ params }: PageProps) {
  const { id } = await params;
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) notFound();

  const trackers = listTrackersFromConfig(cluster.config as Record<string, unknown> | null);

  return <IntegrationsTab clusterId={id} initialTrackers={trackers} />;
}
