import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ id: string }> }

// POST /api/clusters/[id]/nodes/register
// Lightweight sibling of /nodes/add: upserts the node into the cluster config
// with deployed:false. Does NOT install slurmd, touch slurm.conf, or restart
// anything. The node appears in the Nodes tab with a Deploy button that runs
// the real install via /nodes/add.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { nodeName, ip, sshUser, sshPort, cpus, gpus, memoryMb, sockets, coresPerSocket, threadsPerCore } = body;
  if (!nodeName || !ip) {
    return NextResponse.json({ error: "Missing required fields: nodeName, ip" }, { status: 400 });
  }

  // Serialize read-modify-write of cluster.config inside a transaction so
  // concurrent /register calls (e.g. bulk-add parallel workers) don't clobber
  // each other by reading stale config before the previous write commits.
  const result = await prisma.$transaction(async (tx) => {
    const cluster = await tx.cluster.findUnique({ where: { id } });
    if (!cluster) return null;

    const config = (cluster.config ?? {}) as Record<string, unknown>;

    const hostsEntries = (config.slurm_hosts_entries ?? []) as Array<Record<string, unknown>>;
    const newHost = { hostname: nodeName, ip, user: sshUser || "root", port: sshPort || 22 };
    const hostIdx = hostsEntries.findIndex((h) => h.hostname === nodeName);
    if (hostIdx >= 0) hostsEntries[hostIdx] = { ...hostsEntries[hostIdx], ...newHost };
    else hostsEntries.push(newHost);
    config.slurm_hosts_entries = hostsEntries;

    const nodes = (config.slurm_nodes ?? []) as Array<Record<string, unknown>>;
    const existing = nodes.find((n) => n.expression === nodeName || n.name === nodeName);
    const newNode = {
      expression: nodeName,
      cpus: cpus || 0,
      gpus: gpus ?? 0,
      memory_mb: memoryMb || 0,
      sockets: sockets || 1,
      cores_per_socket: coresPerSocket || cpus || 1,
      threads_per_core: threadsPerCore || 1,
      ssh_user: sshUser || "root",
      ssh_port: sshPort || 22,
      ip,
      deployed: existing?.deployed === true ? true : false,
    };
    const nodeIdx = nodes.findIndex((n) => n.expression === nodeName || n.name === nodeName);
    if (nodeIdx >= 0) nodes[nodeIdx] = { ...nodes[nodeIdx], ...newNode };
    else nodes.push(newNode);
    config.slurm_nodes = nodes;

    await tx.cluster.update({ where: { id }, data: { config: config as any } });
    return { deployed: newNode.deployed };
  }, { isolation: "Serializable" });

  if (!result) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  return NextResponse.json({ ok: true, nodeName, deployed: result.deployed });
}
