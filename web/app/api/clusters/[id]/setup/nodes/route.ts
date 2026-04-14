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

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const body = await req.json();
  const { nodes, controllerIsWorker } = body;
  if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
    return NextResponse.json({ error: "nodes array is required" }, { status: 400 });
  }

  // NOTE: The SSH private key is forwarded to the agent in the NATS message payload.
  // NATS is currently configured without TLS (nats://), so this key transits the network
  // in plaintext. This is acceptable for a private management network, but TLS should be
  // added before deployment on untrusted networks.
  const sshKeySetting = await prisma.setting.findUnique({ where: { key: "ssh_private_key" } });
  if (!sshKeySetting) {
    return NextResponse.json(
      { error: "No SSH key configured. Go to Admin → Settings and add the cluster SSH key before onboarding nodes." },
      { status: 412 },
    );
  }
  const sshPrivateKey = Buffer.from(sshKeySetting.value).toString("base64");

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
