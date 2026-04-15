import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string; userId: string }> }

// PATCH /api/clusters/[id]/users/[userId] — update provisioning status after SSE reply
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, userId } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { status } = await req.json();
  if (!["ACTIVE", "FAILED"].includes(status)) {
    return NextResponse.json({ error: "status must be ACTIVE or FAILED" }, { status: 400 });
  }

  const clusterUser = await prisma.clusterUser.update({
    where: { userId_clusterId: { userId, clusterId: id } },
    data: {
      status,
      provisionedAt: status === "ACTIVE" ? new Date() : undefined,
    },
  });

  return NextResponse.json(clusterUser);
}

// DELETE /api/clusters/[id]/users/[userId] — deprovision a user from this cluster
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id, userId } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const clusterUser = await prisma.clusterUser.findUnique({
    where: { userId_clusterId: { userId, clusterId: id } },
  });
  if (!clusterUser) return NextResponse.json({ error: "User not provisioned on this cluster" }, { status: 404 });
  if (clusterUser.status === "REMOVED") {
    return NextResponse.json({ error: "User already removed" }, { status: 409 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Mark as REMOVED immediately so no new jobs can be submitted.
  await prisma.clusterUser.update({
    where: { userId_clusterId: { userId, clusterId: id } },
    data: { status: "REMOVED" },
  });

  // Build worker hosts from cluster config (excluding controller).
  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as Array<{ hostname: string; ip: string }>;
  const workerHosts = hostsEntries
    .filter((h) => h.hostname !== cluster.controllerHost)
    .map((h) => ({ hostname: h.hostname, ip: h.ip }));

  const dataNfsPath = (config.data_nfs_path as string) ?? "/aura-usrdata";
  const username = user.unixUsername ?? user.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const nfsHome = `${dataNfsPath}/${username}`;

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "deprovision_user",
    payload: {
      username,
      uid: user.unixUid ?? 0,
      gid: user.unixGid ?? 0,
      nfs_home: nfsHome,
      worker_hosts: workerHosts,
    },
  });

  return NextResponse.json({ request_id: requestId });
}
