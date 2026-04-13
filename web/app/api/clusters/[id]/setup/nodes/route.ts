import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";

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

  // Read SSH key to forward to agent
  let sshPrivateKey = "";
  const keyPath = process.env.ANSIBLE_SSH_KEY_FILE ?? "/home/nextjs/.ssh/id_ed25519";
  try {
    const keyBytes = readFileSync(keyPath);
    sshPrivateKey = keyBytes.toString("base64");
  } catch {
    // SSH key not available — agent will proceed without it (localhost-only ops work)
  }

  // Save nodes to config
  const config = {
    ...(cluster.config as object),
    slurm_hosts_entries: nodes,
    controller_is_worker: controllerIsWorker ?? false,
  };
  await prisma.cluster.update({ where: { id }, data: { config } });

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "setup_nodes",
    payload: {
      controller_hostname: cluster.controllerHost,
      controller_is_worker: controllerIsWorker ?? false,
      nodes,
      ssh_private_key: sshPrivateKey,
    },
  });

  return NextResponse.json({ request_id: requestId });
}
