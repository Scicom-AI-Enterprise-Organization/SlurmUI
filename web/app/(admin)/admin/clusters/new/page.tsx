import { prisma } from "@/lib/prisma";
import { NewClusterWizard } from "@/components/wizard/new-cluster-wizard";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default async function NewClusterPage() {
  const sshKey = await prisma.setting.findUnique({ where: { key: "ssh_private_key" } });

  if (!sshKey) {
    return (
      <div className="mx-auto max-w-2xl py-8 space-y-6">
        <h1 className="text-3xl font-bold">New Cluster</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 space-y-4">
          <div className="flex items-center gap-2 text-destructive font-semibold text-lg">
            <AlertTriangle className="h-5 w-5" />
            SSH key required before creating a cluster
          </div>
          <p className="text-sm text-muted-foreground">
            Aura needs an SSH key to provision cluster nodes via Ansible. No cluster can be
            created until one is configured.
          </p>
          <Link href="/admin/settings">
            <Button>Go to Settings →</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl py-8">
      <h1 className="mb-8 text-3xl font-bold">New Cluster</h1>
      <NewClusterWizard />
    </div>
  );
}
