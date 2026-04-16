import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClusterStatusBadge } from "@/components/clusters/cluster-status-badge";
import { JobTable } from "@/components/jobs/job-table";
import { Separator } from "@/components/ui/separator";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Server, Send } from "lucide-react";

export default async function JobsPage() {
  const session = await auth();
  if (!session?.user) redirect("/api/auth/signin");

  const [jobs, clusters] = await Promise.all([
    prisma.job.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      include: { cluster: { select: { name: true } } },
    }),
    prisma.cluster.findMany({
      where: { status: { in: ["ACTIVE", "DEGRADED"] } },
      select: {
        id: true,
        name: true,
        controllerHost: true,
        status: true,
        config: true,
      },
      orderBy: { name: "asc" },
    }),
  ]);

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
                <Card key={cluster.id}>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-base">{cluster.name}</CardTitle>
                    <ClusterStatusBadge status={cluster.status} />
                  </CardHeader>
                  <CardContent className="space-y-3">
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

      <Separator />

      {/* Jobs */}
      <Card>
        <CardHeader>
          <CardTitle>All Jobs ({jobs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <JobTable
            jobs={jobs.map((j) => ({ ...j, createdAt: j.createdAt.toISOString() }))}
            showCluster
          />
        </CardContent>
      </Card>
    </div>
  );
}
