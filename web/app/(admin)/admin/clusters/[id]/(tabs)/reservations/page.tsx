import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ReservationsTab } from "@/components/cluster/reservations-tab";
import { RequiresBootstrap } from "@/components/cluster/requires-nodes";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ReservationsPage({ params }: PageProps) {
  const { id } = await params;
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) notFound();
  if (cluster.status !== "ACTIVE") return <RequiresBootstrap />;
  return <ReservationsTab clusterId={id} />;
}
