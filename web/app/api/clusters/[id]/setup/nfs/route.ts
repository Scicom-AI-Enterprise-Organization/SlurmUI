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
  const { mgmtNfsServer, mgmtNfsPath, dataNfsServer, dataNfsPath, nfsAllowedNetwork } = body;
  if (!mgmtNfsServer || !mgmtNfsPath || !dataNfsServer || !dataNfsPath) {
    return NextResponse.json({ error: "Missing NFS fields" }, { status: 400 });
  }

  // Save to cluster config
  const config = { ...(cluster.config as object), mgmt_nfs_server: mgmtNfsServer, mgmt_nfs_path: mgmtNfsPath, data_nfs_server: dataNfsServer, data_nfs_path: dataNfsPath, nfs_allowed_network: nfsAllowedNetwork };
  await prisma.cluster.update({ where: { id }, data: { config } });

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "test_nfs",
    payload: { mgmt_nfs_server: mgmtNfsServer, mgmt_nfs_path: mgmtNfsPath, data_nfs_server: dataNfsServer, data_nfs_path: dataNfsPath },
  });

  return NextResponse.json({ request_id: requestId });
}
