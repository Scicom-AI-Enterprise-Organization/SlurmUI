import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

// POST /api/clusters/[id]/packages — install packages on all cluster nodes
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (cluster.status !== "ACTIVE" && cluster.status !== "DEGRADED") {
    return NextResponse.json({ error: "Cluster is not active" }, { status: 503 });
  }

  const body = await req.json();
  const packages: string[] = body.packages ?? [];
  if (packages.length === 0) {
    return NextResponse.json({ error: "No packages specified" }, { status: 400 });
  }

  const clusterConfig = (cluster.config ?? {}) as Record<string, any>;
  const nodes: Array<{ hostname: string; ip: string }> =
    clusterConfig.slurm_hosts_entries ?? [];
  const workerHosts = nodes
    .filter((n) => n.hostname !== cluster.controllerHost)
    .map((n) => ({ hostname: n.hostname, ip: n.ip }));

  const sshKeySetting = await prisma.setting.findUnique({ where: { key: "ssh_private_key" } });
  const sshPrivateKey = sshKeySetting
    ? Buffer.from(sshKeySetting.value).toString("base64")
    : "";

  // Persist packages to cluster config (optimistic, before publish)
  const existingPackages: string[] = clusterConfig.installed_packages ?? [];
  const merged = Array.from(new Set([...existingPackages, ...packages]));
  await prisma.cluster.update({
    where: { id },
    data: { config: { ...clusterConfig, installed_packages: merged } as any },
  });

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "install_packages",
    payload: {
      packages,
      worker_hosts: workerHosts,
      ssh_private_key: sshPrivateKey,
    },
  });

  return NextResponse.json({ request_id: requestId });
}
