import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PackagesTab } from "@/components/cluster/packages-tab";
import { RequiresBootstrap } from "@/components/cluster/requires-nodes";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PackagesPage({ params }: PageProps) {
  const { id } = await params;
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) notFound();

  if (cluster.status === "PROVISIONING") return <RequiresBootstrap />;

  return <PackagesTab clusterId={id} />;
}
