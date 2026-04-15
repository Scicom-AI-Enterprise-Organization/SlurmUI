import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";

interface RouteParams { params: Promise<{ id: string }> }

// GET /api/clusters/[id]/apps — list active sessions for this user
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sessions = await prisma.appSession.findMany({
    where: {
      clusterId: id,
      userId: session.user.id,
      status: { not: "STOPPED" },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(sessions);
}

// POST /api/clusters/[id]/apps — launch an app session
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (cluster.status !== "ACTIVE" && cluster.status !== "DEGRADED") {
    return NextResponse.json({ error: "Cluster is not accepting connections" }, { status: 503 });
  }

  const dbUser = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!dbUser?.unixUsername) {
    return NextResponse.json(
      { error: "You must be provisioned on this cluster before launching apps." },
      { status: 403 }
    );
  }

  // Verify ACTIVE ClusterUser (admins bypass).
  const isAdmin = (session.user as any).role === "ADMIN";
  if (!isAdmin) {
    const clusterUser = await prisma.clusterUser.findUnique({
      where: { userId_clusterId: { userId: session.user.id, clusterId: id } },
    });
    if (!clusterUser || clusterUser.status !== "ACTIVE") {
      return NextResponse.json(
        { error: "You must be provisioned on this cluster before launching apps." },
        { status: 403 }
      );
    }
  }

  const body = await req.json();
  const { type, partition, ntasks, time_limit } = body;
  if (!type || !["shell", "jupyter"].includes(type)) {
    return NextResponse.json({ error: "type must be 'shell' or 'jupyter'" }, { status: 400 });
  }
  if (!partition) {
    return NextResponse.json({ error: "partition is required" }, { status: 400 });
  }

  const config = cluster.config as Record<string, unknown>;
  const dataNfsPath = (config.data_nfs_path as string | undefined) ?? "/aura-usrdata";
  const nfsHome = `${dataNfsPath}/${dbUser.unixUsername}`;

  // Create session record in DB first.
  const appSession = await prisma.appSession.create({
    data: {
      clusterId: id,
      userId: session.user.id,
      type,
      partition,
      status: "STARTING",
    },
  });

  // Dispatch launch_app to agent (fire-and-forget streaming).
  await publishCommand(id, {
    request_id: appSession.id,
    type: "launch_app",
    payload: {
      app_type: type,
      partition,
      username: dbUser.unixUsername,
      nfs_home: nfsHome,
      ntasks: ntasks ?? 1,
      time_limit: time_limit ?? "2:00:00",
      controller_host: cluster.controllerHost,
    },
  });

  return NextResponse.json(appSession, { status: 201 });
}
