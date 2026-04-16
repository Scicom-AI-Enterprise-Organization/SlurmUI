import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/nodes/add — add a new node outside original range (non-blocking)
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user || (session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  const body = await req.json();
  const { nodeName, ip, cpus, gpus, memoryMb } = body;

  if (!nodeName || !ip || !cpus || !memoryMb) {
    return NextResponse.json(
      { error: "Missing required fields: nodeName, ip, cpus, memoryMb" },
      { status: 400 }
    );
  }

  // Update cluster config to include the new node
  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as Array<{ hostname: string; ip: string }>;
  hostsEntries.push({ hostname: nodeName, ip });
  config.slurm_hosts_entries = hostsEntries;

  const nodes = (config.slurm_nodes ?? []) as Array<Record<string, unknown>>;
  nodes.push({ expression: nodeName, cpus, gpus: gpus ?? 0, memory_mb: memoryMb });
  config.slurm_nodes = nodes;

  await prisma.cluster.update({
    where: { id },
    data: { config: config as any },
  });

  // Gather existing ACTIVE users for replication on the new node
  const activeClusterUsers = await prisma.clusterUser.findMany({
    where: { clusterId: id, status: "ACTIVE" },
    include: { user: { select: { unixUsername: true, unixUid: true, unixGid: true } } },
  });
  const existingUsers = activeClusterUsers
    .filter((cu) => cu.user.unixUsername && cu.user.unixUid != null && cu.user.unixGid != null)
    .map((cu) => ({
      username: cu.user.unixUsername!,
      uid: cu.user.unixUid!,
      gid: cu.user.unixGid!,
    }));

  // Gather previously installed packages
  const extraPackages: string[] = (config.installed_packages as string[]) ?? [];

  const requestId = randomUUID();

  try {
    await publishCommand(id, {
      request_id: requestId,
      type: "add_node",
      payload: {
        target_node: nodeName,
        target_ip: ip,
        config,
        existing_users: existingUsers,
        extra_packages: extraPackages,
      },
    });

    return NextResponse.json({ request_id: requestId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
