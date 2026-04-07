"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { WizardShell } from "@/components/wizard/wizard-shell";
import { StepBasics } from "@/components/wizard/step-basics";
import { StepStorage } from "@/components/wizard/step-storage";
import { StepNodes, type NodeDefinition, type HostEntry } from "@/components/wizard/step-nodes";
import { StepPartitions, type PartitionDefinition } from "@/components/wizard/step-partitions";
import { StepReview } from "@/components/wizard/step-review";
import { StepLiveLog } from "@/components/wizard/step-live-log";

const steps = [
  { title: "Basics", description: "Cluster name and controller info" },
  { title: "Storage", description: "NFS configuration" },
  { title: "Nodes", description: "Define compute nodes" },
  { title: "Partitions", description: "Configure Slurm partitions" },
  { title: "Review", description: "Review configuration" },
  { title: "Bootstrap", description: "Live bootstrap progress" },
];

export default function NewClusterPage() {
  const router = useRouter();

  const [basics, setBasics] = useState({
    clusterName: "",
    controllerHost: "",
    controllerIp: "",
    freeipaServer: "ipa.scicom.internal",
    freeipaDomain: "scicom.internal",
  });

  const [storage, setStorage] = useState({
    mgmtNfsServer: "",
    mgmtNfsPath: "/mgmt",
    dataNfsServer: "",
    dataNfsPath: "/aura-usrdata",
    nfsAllowedNetwork: "",
  });

  const [nodes, setNodes] = useState<NodeDefinition[]>([]);
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [partitions, setPartitions] = useState<PartitionDefinition[]>([]);

  const [clusterId, setClusterId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  const buildConfig = () => ({
    slurm_cluster_name: basics.clusterName,
    slurm_controller_host: basics.controllerHost,
    mgmt_nfs_server: storage.mgmtNfsServer,
    data_nfs_server: storage.dataNfsServer,
    mgmt_nfs_path: storage.mgmtNfsPath,
    data_nfs_path: storage.dataNfsPath,
    nfs_allowed_network: storage.nfsAllowedNetwork,
    freeipa_server: basics.freeipaServer,
    freeipa_domain: basics.freeipaDomain,
    aura_agent_nats_url: process.env.NEXT_PUBLIC_NATS_URL ?? "nats://aura-web.scicom.internal:4222",
    aura_agent_binary_src: "/tmp/aura-agent",
    slurm_nodes: nodes.map((n) => ({
      expression: n.expression,
      cpus: n.cpus,
      gpus: n.gpus,
      memory_mb: n.memoryMb,
    })),
    slurm_partitions: partitions.map((p) => ({
      name: p.name,
      nodes: p.nodes,
      max_time: p.maxTime,
      default: p.isDefault,
    })),
    slurm_hosts_entries: [
      { hostname: basics.controllerHost, ip: basics.controllerIp },
      ...hosts,
    ],
  });

  const canProgress = (step: number): boolean => {
    switch (step) {
      case 0:
        return !!(basics.clusterName && basics.controllerHost && basics.controllerIp);
      case 1:
        return !!(storage.mgmtNfsServer && storage.dataNfsServer && storage.nfsAllowedNetwork);
      case 2:
        return nodes.length > 0 && hosts.length > 0;
      case 3:
        return partitions.length > 0;
      case 4:
        return true; // Review step: always allowed
      case 5:
        return false; // Bootstrap step: never "next" — user watches log
      default:
        return true;
    }
  };

  const handleComplete = async () => {
    // When step 4 (Review) completes, create cluster and start bootstrap
    const config = buildConfig();

    try {
      const res = await fetch("/api/clusters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: basics.clusterName,
          controllerHost: basics.controllerHost,
          config,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        alert(`Failed to create cluster: ${err.error}`);
        return;
      }

      const cluster = await res.json();
      setClusterId(cluster.id);

      // Trigger bootstrap
      const bootstrapRes = await fetch(`/api/clusters/${cluster.id}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "bootstrap",
          args: { config },
          timeout: 600000,
        }),
      });

      if (bootstrapRes.ok) {
        const bootstrapData = await bootstrapRes.json();
        setRequestId(bootstrapData.request_id);
      }
    } catch (err) {
      console.error("Failed to start bootstrap:", err);
    }
  };

  return (
    <div className="mx-auto max-w-4xl py-8">
      <h1 className="mb-8 text-3xl font-bold">New Cluster</h1>
      <WizardShell steps={steps} onComplete={handleComplete} canProgress={canProgress}>
        <StepBasics data={basics} onChange={setBasics} />
        <StepStorage data={storage} onChange={setStorage} />
        <StepNodes
          nodes={nodes}
          hosts={hosts}
          onNodesChange={setNodes}
          onHostsChange={setHosts}
        />
        <StepPartitions
          partitions={partitions}
          availableNodeExpressions={nodes.map((n) => n.expression).filter(Boolean)}
          onChange={setPartitions}
        />
        <StepReview config={buildConfig()} />
        <StepLiveLog requestId={requestId} clusterId={clusterId} />
      </WizardShell>
    </div>
  );
}
