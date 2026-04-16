import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { UsersTab } from "@/components/cluster/users-tab";
import { RequiresBootstrap } from "@/components/cluster/requires-nodes";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function UsersPage({ params }: PageProps) {
  const { id } = await params;
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) notFound();

  if (cluster.status !== "ACTIVE") return <RequiresBootstrap />;

  return <UsersTab clusterId={id} />;
}
