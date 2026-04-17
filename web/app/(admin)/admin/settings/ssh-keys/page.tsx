import { prisma } from "@/lib/prisma";
import { SshKeySettings } from "@/components/admin/ssh-key-settings";

export default async function SshKeysSettingsPage() {
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

  return <SshKeySettings initialKeys={JSON.parse(JSON.stringify(keys))} />;
}
