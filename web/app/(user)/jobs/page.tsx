import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClusterStatusBadge } from "@/components/clusters/cluster-status-badge";
import { PagedJobs } from "@/components/jobs/paged-jobs";
import { Separator } from "@/components/ui/separator";
import Link from "next/link";
import { Server } from "lucide-react";
import { effectiveClusterStatus } from "@/lib/cluster-health";

export default async function JobsPage() {
  const session = await auth();
  if (!session?.user) redirect("/api/auth/signin");

  // Pull all non-provisioning clusters, then filter by the probe-derived
  // effective status. The DB's `status` column lags behind the probe, so a
  // cluster that's actually alive can still be stamped OFFLINE in the
  // column — those clusters would otherwise disappear from this page
  // despite the status card calling them Active.
  const all = await prisma.cluster.findMany({
    where: { status: { not: "PROVISIONING" } },
    select: {
      id: true,
      name: true,
      controllerHost: true,
      status: true,
      config: true,
    },
    orderBy: { name: "asc" },
  });
  const clusters = all
    .map((c) => ({ ...c, status: effectiveClusterStatus(c) as typeof c.status }))
    .filter((c) => c.status === "ACTIVE" || c.status === "DEGRADED");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Jobs</h1>
        <p className="text-muted-foreground">Your Slurm jobs and available clusters</p>
      </div>

      {/* Clusters */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Available Clusters</h2>
        {clusters.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
            No clusters available at the moment
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {clusters.map((cluster) => {
              const config = cluster.config as Record<string, unknown>;
              const partitions = (config.slurm_partitions ?? []) as Array<{ name: string }>;
              const nodeGroups = (config.slurm_hosts_entries ?? []) as Array<{ hostname: string }>;

              return (
                <Link
                  key={cluster.id}
                  href={`/clusters/${cluster.id}/jobs`}
                  className="block rounded-lg transition-colors"
                >
                  <Card className="h-full cursor-pointer hover:border-primary/60 transition-colors">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-base">{cluster.name}</CardTitle>
                      <ClusterStatusBadge status={cluster.status} />
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-1 text-sm text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <Server className="h-3.5 w-3.5" />
                          <span>{cluster.controllerHost}</span>
                        </div>
                        <p>
                          {nodeGroups.length} node{nodeGroups.length !== 1 ? "s" : ""} |{" "}
                          {partitions.length} partition{partitions.length !== 1 ? "s" : ""}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <Separator />

      {/* All Jobs — paginated */}
      <Card>
        <CardHeader>
          <CardTitle>All Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <PagedJobs />
        </CardContent>
      </Card>
    </div>
  );
}
