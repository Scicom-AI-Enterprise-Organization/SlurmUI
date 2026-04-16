import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ClusterStatusBadge } from "@/components/clusters/cluster-status-badge";
import { ConfigEditor } from "@/components/clusters/config-editor";
import { SetupStepper } from "@/components/cluster/setup-stepper";
import { UsersTab } from "@/components/cluster/users-tab";
import { PackagesTab } from "@/components/cluster/packages-tab";
import { DeleteClusterButton } from "@/components/cluster/delete-cluster-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Link from "next/link";
import { Server, Settings, Monitor } from "lucide-react";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ClusterDetailPage({ params }: PageProps) {
  const { id } = await params;

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { _count: { select: { jobs: true } } },
  });

  if (!cluster) {
    notFound();
  }

  const sshKeyConfigured = !!cluster.sshKeyId;

  const config = cluster.config as Record<string, unknown>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{cluster.name}</h1>
            <ClusterStatusBadge status={cluster.status} />
          </div>
          <p className="text-muted-foreground">
            Controller: {cluster.controllerHost}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/admin/clusters/${id}/nodes`}>
            <Button variant="outline">
              <Monitor className="mr-2 h-4 w-4" />
              Manage Nodes
            </Button>
          </Link>
          <DeleteClusterButton clusterId={id} clusterName={cluster.name} />
        </div>
      </div>

      {cluster.status === "PROVISIONING" ? (
        <SetupStepper clusterId={cluster.id} controllerHost={cluster.controllerHost} sshKeyConfigured={sshKeyConfigured} />
      ) : (
        <>
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

          <Tabs defaultValue="config">
            <TabsList>
              <TabsTrigger value="config">Configuration</TabsTrigger>
              <TabsTrigger value="users">Users</TabsTrigger>
              <TabsTrigger value="packages">Packages</TabsTrigger>
            </TabsList>
            <TabsContent value="config">
              <ConfigEditor clusterId={id} initialConfig={config} />
            </TabsContent>
            <TabsContent value="users">
              <UsersTab clusterId={id} />
            </TabsContent>
            <TabsContent value="packages">
              <PackagesTab clusterId={id} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
