import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ConfigEditor } from "@/components/clusters/config-editor";
import { AccountingCard } from "@/components/cluster/accounting-card";
import { GitopsOnlyCard } from "@/components/cluster/gitops-only-card";
import { RunpodProvisionCard } from "@/components/cluster/runpod-provision-card";
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

  // RunPod-backed cluster: surface the pod + provisioning log so the user
  // can see what happened (or is still happening) before bootstrapping.
  const runpod = (cluster.config as any)?.runpod ?? null;
  const provisionTask = runpod
    ? await prisma.backgroundTask.findFirst({
        where: { clusterId: id, type: "runpod_provision" },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, logs: true },
      })
    : null;

  return (
    <div className="space-y-6">
      {runpod && (
        <RunpodProvisionCard
          runpod={runpod}
          initialTask={provisionTask ? JSON.parse(JSON.stringify(provisionTask)) : null}
        />
      )}
      {controllerReachable && <AccountingCard clusterId={id} />}
      <GitopsOnlyCard clusterId={id} />
      <ConfigEditor clusterId={id} initialConfig={config} />
    </div>
  );
}
