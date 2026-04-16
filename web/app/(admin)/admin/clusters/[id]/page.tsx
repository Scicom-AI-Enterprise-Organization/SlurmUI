import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ClusterDetailPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/admin/clusters/${id}/configuration`);
}
