"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StepBasics, type ClusterBasics, type SshKeyOption, type SshTestStatus } from "@/components/wizard/step-basics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

interface NewClusterWizardProps {
  sshKeys: SshKeyOption[];
}

export function NewClusterWizard({ sshKeys }: NewClusterWizardProps) {
  const router = useRouter();
  const [basics, setBasics] = useState<ClusterBasics>({
    clusterName: "",
    controllerHost: "",
    connectionMode: "SSH",
    natsUrl: "",
    sshUser: "root",
    sshPort: "22",
    sshKeyId: sshKeys.length === 1 ? sshKeys[0].id : "",
    sshJumpHost: "",
    sshJumpUser: "root",
    sshJumpPort: "22",
    sshJumpKeyId: "",
    sshProxyCommand: "",
    sshJumpProxyCommand: "",
  });
  const [creating, setCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sshTestStatus, setSshTestStatus] = useState<SshTestStatus>("idle");

  const canCreate = (() => {
    const base = !!(basics.clusterName && basics.controllerHost && basics.sshKeyId && sshTestStatus === "ok");
    if (basics.connectionMode === "NATS") return base && !!basics.natsUrl;
    return base;
  })();

  const handleCreate = async () => {
    setCreating(true);
    setErrorMsg(null);
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
          sshJumpHost: basics.sshJumpHost || undefined,
          sshJumpUser: basics.sshJumpHost ? (basics.sshJumpUser || "root") : undefined,
          sshJumpPort: basics.sshJumpHost ? (parseInt(basics.sshJumpPort) || 22) : undefined,
          sshJumpKeyId: basics.sshJumpHost && basics.sshJumpKeyId ? basics.sshJumpKeyId : undefined,
          sshProxyCommand: basics.sshProxyCommand || undefined,
          sshJumpProxyCommand: basics.sshJumpProxyCommand || undefined,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text();
        let msg: string;
        try {
          const err = JSON.parse(bodyText);
          msg = err.error ?? `HTTP ${res.status}`;
        } catch {
          // Non-JSON response (Next.js 500 HTML page, for instance) — show a
          // truncated excerpt so the real error isn't hidden.
          msg = `HTTP ${res.status}: ${bodyText.slice(0, 300)}`;
        }
        setErrorMsg(msg);
        return;
      }
      const cluster = await res.json();
      router.push(`/admin/clusters/${cluster.id}/configuration`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to create cluster. Please check your connection and try again.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div className="space-y-6">
        <StepBasics data={basics} onChange={setBasics} sshKeys={sshKeys} onSshTestChange={setSshTestStatus} />

        <Button onClick={handleCreate} disabled={!canCreate || creating} className="w-full">
          {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {creating ? "Creating..." : "Create Cluster"}
        </Button>
      </div>

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
