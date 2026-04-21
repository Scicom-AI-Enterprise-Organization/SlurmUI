import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ConfigEditor } from "@/components/clusters/config-editor";
import { AccountingCard } from "@/components/cluster/accounting-card";
import { GitopsOnlyCard } from "@/components/cluster/gitops-only-card";
import { redactConfig } from "@/lib/redact-config";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ConfigurationPage({ params }: PageProps) {
  const { id } = await params;
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) notFound();

  // Never ship raw secrets (S3 keys, passwords, etc.) into the browser.
  // ConfigEditor shows the masked version; the save endpoint merges real
  // secrets back from the DB when it sees the mask.
  const config = redactConfig(cluster.config as Record<string, unknown>);

  return (
    <div className="space-y-6">
      {cluster.status === "ACTIVE" && <AccountingCard clusterId={id} />}
      <GitopsOnlyCard clusterId={id} />
      <ConfigEditor clusterId={id} initialConfig={config} />
    </div>
  );
}
