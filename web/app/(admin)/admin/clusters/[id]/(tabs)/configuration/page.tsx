import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ConfigEditor } from "@/components/clusters/config-editor";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ConfigurationPage({ params }: PageProps) {
  const { id } = await params;
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) notFound();

  const config = cluster.config as Record<string, unknown>;

  return <ConfigEditor clusterId={id} initialConfig={config} />;
}
