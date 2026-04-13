"use client";

import { useState } from "react";
import { WizardShell } from "@/components/wizard/wizard-shell";
import { StepBasics } from "@/components/wizard/step-basics";
import { StepInstall } from "@/components/wizard/step-install";

const steps = [
  { title: "Basics", description: "Cluster name and controller hostname" },
  { title: "Install Agent", description: "Run the one-liner on your master node" },
];

export default function NewClusterPage() {
  const [basics, setBasics] = useState({ clusterName: "", controllerHost: "" });
  const [clusterId, setClusterId] = useState<string | null>(null);

  const canProgress = (step: number): boolean => {
    if (step === 0) return !!(basics.clusterName && basics.controllerHost);
    return false; // Step 1: wait for agent — no "next" button
  };

  // Called before advancing from Step 0. Creates the cluster record.
  const handleBeforeNext = async (step: number): Promise<boolean | void> => {
    if (step !== 0) return;
    try {
      const res = await fetch("/api/clusters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: basics.clusterName,
          controllerHost: basics.controllerHost,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Failed to create cluster: ${err.error}`);
        return false;
      }
      const cluster = await res.json();
      setClusterId(cluster.id);
    } catch {
      alert("Failed to create cluster");
      return false;
    }
  };

  return (
    <div className="mx-auto max-w-2xl py-8">
      <h1 className="mb-8 text-3xl font-bold">New Cluster</h1>
      <WizardShell
        steps={steps}
        onComplete={() => {}}
        onBeforeNext={handleBeforeNext}
        canProgress={canProgress}
      >
        <StepBasics data={basics} onChange={setBasics} />
        <StepInstall clusterId={clusterId} />
      </WizardShell>
    </div>
  );
}
