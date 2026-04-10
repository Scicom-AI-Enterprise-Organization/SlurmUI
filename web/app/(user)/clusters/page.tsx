import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClusterStatusBadge } from "@/components/clusters/cluster-status-badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Server, Send } from "lucide-react";

export default async function UserClustersPage() {
  const session = await auth();
  if (!session?.user) redirect("/api/auth/signin");

  const clusters = await prisma.cluster.findMany({
    where: {
      status: { in: ["ACTIVE", "DEGRADED"] },
    },
    select: {
      id: true,
      name: true,
      controllerHost: true,
      status: true,
      config: true,
    },
    orderBy: { name: "asc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Available Clusters</h1>
        <p className="text-muted-foreground">
          Select a cluster to submit jobs
        </p>
      </div>

      {clusters.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12">
          <p className="text-lg text-muted-foreground">
            No clusters available at the moment
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {clusters.map((cluster) => {
            const config = cluster.config as Record<string, unknown>;
            const partitions = (config.slurm_partitions ?? []) as Array<{ name: string }>;
            const nodeGroups = (config.slurm_nodes ?? []) as Array<{ expression: string }>;

            return (
              <Card key={cluster.id}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-lg">{cluster.name}</CardTitle>
                  <ClusterStatusBadge status={cluster.status} />
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Server className="h-4 w-4" />
                      <span>{cluster.controllerHost}</span>
                    </div>
                    <p>
                      {nodeGroups.length} node group{nodeGroups.length !== 1 ? "s" : ""} |{" "}
                      {partitions.length} partition{partitions.length !== 1 ? "s" : ""}
                    </p>
                    {partitions.length > 0 && (
                      <p className="text-xs">
                        Partitions: {partitions.map((p) => p.name).join(", ")}
                      </p>
                    )}
                  </div>
                  <Link href={`/clusters/${cluster.id}/jobs/new`}>
                    <Button className="w-full" size="sm">
                      <Send className="mr-2 h-4 w-4" />
                      Submit Job
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
