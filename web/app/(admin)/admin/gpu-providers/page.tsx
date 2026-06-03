import { prisma } from "@/lib/prisma";
import { GpuProviderList } from "@/components/admin/gpu-provider-list";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus } from "lucide-react";

export default async function GpuProvidersPage() {
  const providers = await prisma.gpuProvider.findMany({
    select: {
      id: true,
      name: true,
      kind: true,
      apiKeyLast4: true,
      accountEmail: true,
      validatedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">GPU Providers</h1>
          <p className="text-muted-foreground">
            Cloud GPU accounts for on-demand compute
          </p>
        </div>
        <Link href="/admin/gpu-providers/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            New Provider
          </Button>
        </Link>
      </div>

      {providers.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12">
          <p className="text-lg text-muted-foreground">No GPU providers yet</p>
          <Link href="/admin/gpu-providers/new" className="mt-4">
            <Button variant="outline">Add your first provider</Button>
          </Link>
        </div>
      ) : (
        <GpuProviderList initialProviders={JSON.parse(JSON.stringify(providers))} />
      )}
    </div>
  );
}
