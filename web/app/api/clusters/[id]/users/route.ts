import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

// GET /api/clusters/[id]/users — list provisioned users
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const clusterUsers = await prisma.clusterUser.findMany({
    where: { clusterId: id },
    include: { user: { select: { id: true, email: true, name: true, unixUid: true, unixGid: true } } },
    orderBy: { provisionedAt: "desc" },
  });

  return NextResponse.json(clusterUsers);
}

// POST /api/clusters/[id]/users — provision a user to this cluster
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (cluster.status !== "ACTIVE") {
    return NextResponse.json({ error: "Cluster must be ACTIVE to provision users" }, { status: 409 });
  }

  const { userId } = await req.json();
  if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Check not already provisioned
  const existing = await prisma.clusterUser.findUnique({
    where: { userId_clusterId: { userId, clusterId: id } },
  });
  if (existing && existing.status === "ACTIVE") {
    return NextResponse.json({ error: "User already provisioned to this cluster" }, { status: 409 });
  }

  // Allocate UID if not yet assigned (global, starting from 10000)
  let { unixUid, unixGid } = user;
  if (!unixUid) {
    // Allocate UID atomically to prevent races when two users are provisioned concurrently.
    // The transaction serializes the read-increment-write so no two users get the same UID.
    const updated = await prisma.$transaction(async (tx) => {
      const maxResult = await tx.user.aggregate({ _max: { unixUid: true } });
      const newUid = (maxResult._max.unixUid ?? 9999) + 1;
      return tx.user.update({
        where: { id: userId },
        data: { unixUid: newUid, unixGid: newUid },
      });
    });
    unixUid = updated.unixUid!;
    unixGid = updated.unixGid!;
  }

  // Create or reset ClusterUser record
  const clusterUser = await prisma.clusterUser.upsert({
    where: { userId_clusterId: { userId, clusterId: id } },
    create: { userId, clusterId: id, status: "PENDING" },
    update: { status: "PENDING", provisionedAt: null },
  });

  // Build worker hosts from cluster config
  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as Array<{ hostname: string; ip: string }>;
  const controllerHost = cluster.controllerHost;
  const workerHosts = hostsEntries
    .filter((h) => h.hostname !== controllerHost)
    .map((h) => ({ hostname: h.hostname, ip: h.ip }));

  const dataNfsPath = (config.data_nfs_path as string) ?? "/aura-usrdata";
  const username = user.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase();

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "provision_user",
    payload: {
      username,
      uid: unixUid,
      gid: unixGid,
      nfs_home: `${dataNfsPath}/${username}`,
      worker_hosts: workerHosts,
    },
  });

  return NextResponse.json({ request_id: requestId, clusterUserId: clusterUser.id });
}
