import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { IntegrationsTab } from "@/components/cluster/integrations-tab";
import { listTrackersFromConfig } from "@/lib/experiment-trackers";
import { readGithubCredsList } from "@/lib/git-credentials";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function IntegrationsPage({ params }: PageProps) {
  const { id } = await params;
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) notFound();

  const trackers = listTrackersFromConfig(cluster.config as Record<string, unknown> | null);

  // Git credentials — multiple entries are supported (one PAT per team /
  // scope). Strip the token here so it never crosses the server→client
  // boundary; the UI only needs hasToken bool to render the "configured"
  // chip + the rotate/remove buttons.
  const ghAll = readGithubCredsList(cluster.config);
  const initialGithub = ghAll.map(({ token: _t, ...rest }) => ({
    ...rest,
    // `as const` pins hasToken to the literal `true` (not `boolean`) so it
    // matches the client interface's `hasToken: true` field type.
    hasToken: true as const,
  }));

  return (
    <IntegrationsTab
      clusterId={id}
      initialTrackers={trackers}
      initialGithub={initialGithub}
    />
  );
}
