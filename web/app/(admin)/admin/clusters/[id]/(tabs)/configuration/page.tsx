import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ConfigEditor } from "@/components/clusters/config-editor";
import { AccountingCard } from "@/components/cluster/accounting-card";
import { GitopsOnlyCard } from "@/components/cluster/gitops-only-card";
import { redactConfig } from "@/lib/redact-config";
import { effectiveClusterStatus } from "@/lib/cluster-health";

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

  // Accounting card needs the controller reachable. Use the probe-derived
  // effective status (trusts `config.health.alive`) instead of the raw DB
  // column — the column flips OFFLINE only after 2 consecutive probe fails,
  // so a single transient SSH timeout would otherwise hide this card on
  // an actually-healthy cluster (the bug the user kept refreshing past).
  // DEGRADED clusters are also fine here — the controller is reachable;
  // it's the worker side that's degraded.
  const eff = effectiveClusterStatus(cluster);
  const controllerReachable = eff === "ACTIVE" || eff === "DEGRADED";

  return (
    <div className="space-y-6">
      {controllerReachable && <AccountingCard clusterId={id} />}
      <GitopsOnlyCard clusterId={id} />
      <ConfigEditor clusterId={id} initialConfig={config} />
    </div>
  );
}
