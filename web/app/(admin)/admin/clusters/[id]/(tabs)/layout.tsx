import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ClusterStatusBadge } from "@/components/clusters/cluster-status-badge";
import { DeleteClusterButton } from "@/components/cluster/delete-cluster-button";
import { BootstrapButton } from "@/components/cluster/bootstrap-button";
import { TerminalButton } from "@/components/cluster/terminal-button";
import { LogsButton } from "@/components/cluster/logs-button";
import { ClusterTabs } from "@/components/cluster/cluster-tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Server, Settings, Briefcase } from "lucide-react";

interface LayoutProps {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}

export default async function ClusterTabsLayout({ params, children }: LayoutProps) {
  const { id } = await params;

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { _count: { select: { jobs: true } } },
  });

  if (!cluster) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{cluster.name}</h1>
            <ClusterStatusBadge status={cluster.status} />
          </div>
          <p className="text-muted-foreground">Controller: {cluster.controllerHost}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/clusters/${id}/jobs`}>
            <Button variant="outline">
              <Briefcase className="mr-2 h-4 w-4" />
              Jobs
            </Button>
          </Link>
          <TerminalButton clusterId={id} />
          <LogsButton clusterId={id} />
          <BootstrapButton clusterId={id} clusterName={cluster.name} />
          <DeleteClusterButton clusterId={id} clusterName={cluster.name} />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Status</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <ClusterStatusBadge status={cluster.status} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Jobs</CardTitle>
            <Settings className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{cluster._count.jobs}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Created</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm">
              {cluster.createdAt.toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <Separator />

      <ClusterTabs clusterId={id} hasNodes={((cluster.config as any)?.slurm_hosts_entries ?? []).length > 0} />
      {children}
    </div>
  );
}
