import { prisma } from "@/lib/prisma";
import { SshKeySettings } from "@/components/admin/ssh-key-settings";

export default async function AdminSettingsPage() {
  const keys = await prisma.sshKey.findMany({
    select: {
      id: true,
      name: true,
      publicKey: true,
      createdAt: true,
      _count: { select: { clusters: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">Global admin configuration</p>
      </div>
      <SshKeySettings initialKeys={JSON.parse(JSON.stringify(keys))} />
    </div>
  );
}
