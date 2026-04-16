"use client";

import { useState } from "react";
import { WizardShell } from "@/components/wizard/wizard-shell";
import { StepBasics, type ClusterBasics, type SshKeyOption } from "@/components/wizard/step-basics";
import { StepInstall } from "@/components/wizard/step-install";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface NewClusterWizardProps {
  sshKeys: SshKeyOption[];
}

export function NewClusterWizard({ sshKeys }: NewClusterWizardProps) {
  const [basics, setBasics] = useState<ClusterBasics>({
    clusterName: "",
    controllerHost: "",
    connectionMode: "SSH",
    natsUrl: "",
    sshUser: "root",
    sshPort: "22",
    sshKeyId: sshKeys.length === 1 ? sshKeys[0].id : "",
  });
  const [clusterId, setClusterId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const steps = [
    { title: "Basics", description: "Cluster name, host, and connection settings" },
    {
      title: basics.connectionMode === "SSH" ? "Verify Connection" : "Deploy Agent",
      description: basics.connectionMode === "SSH"
        ? "Test SSH connectivity to the node"
        : "Install the agent via SSH",
    },
  ];

  const canProgress = (step: number): boolean => {
    if (step === 0) {
      const base = !!(basics.clusterName && basics.controllerHost && basics.sshKeyId);
      if (basics.connectionMode === "NATS") return base && !!basics.natsUrl;
      return base;
    }
    return false;
  };

  const handleBeforeNext = async (step: number): Promise<boolean | void> => {
    if (step !== 0) return;
    try {
      const res = await fetch("/api/clusters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: basics.clusterName,
          controllerHost: basics.controllerHost,
          connectionMode: basics.connectionMode,
          natsUrl: basics.natsUrl || undefined,
          sshKeyId: basics.sshKeyId,
          sshUser: basics.sshUser || "root",
          sshPort: parseInt(basics.sshPort) || 22,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setErrorMsg(err.error ?? "Failed to create cluster");
        return false;
      }
      const cluster = await res.json();
      setClusterId(cluster.id);
    } catch {
      setErrorMsg("Failed to create cluster. Please check your connection and try again.");
      return false;
    }
  };

  return (
    <>
      <WizardShell
        steps={steps}
        onComplete={() => {}}
        onBeforeNext={handleBeforeNext}
        canProgress={canProgress}
      >
        <StepBasics data={basics} onChange={setBasics} sshKeys={sshKeys} />
        <StepInstall
          clusterId={clusterId}
          connectionMode={basics.connectionMode}
          sshUser={basics.sshUser}
          sshPort={basics.sshPort}
          natsUrl={basics.natsUrl}
        />
      </WizardShell>

      <Dialog open={!!errorMsg} onOpenChange={(open) => { if (!open) setErrorMsg(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
            <DialogDescription>{errorMsg}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button>OK</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
