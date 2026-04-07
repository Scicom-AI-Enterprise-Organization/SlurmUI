import { prisma } from "@/lib/prisma";
import { ClusterCard } from "@/components/clusters/cluster-card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus } from "lucide-react";

export default async function ClustersPage() {
  const clusters = await prisma.cluster.findMany({
    select: {
      id: true,
      name: true,
      controllerHost: true,
      status: true,
      createdAt: true,
      _count: {
        select: { jobs: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Clusters</h1>
          <p className="text-muted-foreground">
            Manage your GPU clusters
          </p>
        </div>
        <Link href="/admin/clusters/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            New Cluster
          </Button>
        </Link>
      </div>

      {clusters.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12">
          <p className="text-lg text-muted-foreground">No clusters yet</p>
          <Link href="/admin/clusters/new" className="mt-4">
            <Button variant="outline">Create your first cluster</Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {clusters.map((cluster) => (
            <ClusterCard
              key={cluster.id}
              id={cluster.id}
              name={cluster.name}
              controllerHost={cluster.controllerHost}
              status={cluster.status as any}
              jobCount={cluster._count.jobs}
              createdAt={cluster.createdAt.toISOString()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
