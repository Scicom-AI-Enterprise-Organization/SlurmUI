import { prisma } from "@/lib/prisma";
import { SshKeySettings } from "@/components/admin/ssh-key-settings";

export default async function AdminSettingsPage() {
  const [priv, pub] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "ssh_private_key" } }),
    prisma.setting.findUnique({ where: { key: "ssh_public_key" } }),
  ]);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">Global admin configuration</p>
      </div>
      <SshKeySettings
        initialConfigured={!!priv}
        initialPublicKey={pub?.value ?? null}
      />
    </div>
  );
}
