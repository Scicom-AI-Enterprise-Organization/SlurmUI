import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const clusterConfig = (cluster.config ?? {}) as Record<string, any>;
  const nodes: Array<{ hostname: string; ip: string; cpus: number; memory_mb: number; gpus: number }> =
    clusterConfig.slurm_hosts_entries ?? [];

  // Exclude the controller from the workers list — it's always localhost in the playbook.
  const workerNodes = nodes.filter((n) => n.hostname !== cluster.controllerHost);

  const sshPrivateKey = cluster.sshKey
    ? Buffer.from(cluster.sshKey.privateKey).toString("base64")
    : "";

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "teardown",
    payload: {
      nodes: workerNodes,
      ssh_private_key: sshPrivateKey,
      mgmt_nfs_path:  clusterConfig.mgmt_nfs_path  ?? "",
      data_nfs_path:  clusterConfig.data_nfs_path  ?? "",
    },
  });

  return NextResponse.json({ request_id: requestId });
}
