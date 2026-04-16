import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
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

  const body = await req.json();
  const { nodes, controllerIsWorker } = body;
  if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
    return NextResponse.json({ error: "nodes array is required" }, { status: 400 });
  }

  if (!cluster.sshKey) {
    return NextResponse.json(
      { error: "No SSH key assigned to this cluster." },
      { status: 412 },
    );
  }
  const sshPrivateKey = Buffer.from(cluster.sshKey.privateKey).toString("base64");

  // Save nodes to config
  const config = {
    ...(cluster.config as object),
    slurm_hosts_entries: nodes,
    controller_is_worker: controllerIsWorker ?? false,
  };
  await prisma.cluster.update({ where: { id }, data: { config } });

  const requestId = randomUUID();
  const clusterConfig = (cluster.config ?? {}) as Record<string, any>;
  await publishCommand(id, {
    request_id: requestId,
    type: "setup_nodes",
    payload: {
      cluster_name: cluster.name,
      controller_hostname: cluster.controllerHost,
      controller_is_worker: controllerIsWorker ?? false,
      nodes,
      ssh_private_key: sshPrivateKey,
      mgmt_nfs_server: clusterConfig.mgmt_nfs_server ?? "",
      mgmt_nfs_path:   clusterConfig.mgmt_nfs_path   ?? "",
      data_nfs_server: clusterConfig.data_nfs_server ?? "",
      data_nfs_path:   clusterConfig.data_nfs_path   ?? "",
    },
  });

  return NextResponse.json({ request_id: requestId });
}
