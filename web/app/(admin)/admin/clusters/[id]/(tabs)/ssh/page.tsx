import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { SshSettingsEditor } from "@/components/cluster/ssh-settings-editor";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function SshPage({ params }: PageProps) {
  const { id } = await params;

  const [cluster, sshKeys] = await Promise.all([
    prisma.cluster.findUnique({ where: { id } }),
    prisma.sshKey.findMany({
      select: { id: true, name: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  if (!cluster) notFound();

  return (
    <SshSettingsEditor
      clusterId={id}
      initialHost={cluster.controllerHost}
      initialUser={cluster.sshUser}
      initialPort={cluster.sshPort}
      initialBastion={cluster.sshBastion}
      initialSshKeyId={cluster.sshKeyId}
      sshKeys={sshKeys}
    />
  );
}
