import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommandAndWait } from "@/lib/nats";

interface RouteParams { params: Promise<{ id: string }> }

// GET /api/clusters/[id]/files?path=... — list directory contents via agent
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  // All users (including admins) must be actively provisioned to browse files.
  const clusterUser = await prisma.clusterUser.findUnique({
    where: { userId_clusterId: { userId: session.user.id, clusterId: id } },
  });
  if (!clusterUser || clusterUser.status !== "ACTIVE") {
    return NextResponse.json(
      { error: "No provisioned user on this cluster. Contact your admin." },
      { status: 403 }
    );
  }

  const dbUser = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!dbUser?.unixUsername) {
    return NextResponse.json({ error: "No Linux account provisioned" }, { status: 403 });
  }

  const config = cluster.config as Record<string, unknown>;
  const dataNfsPath = (config.data_nfs_path as string | undefined) ?? "/aura-usrdata";
  const nfsHome = `${dataNfsPath}/${dbUser.unixUsername}`;

  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";

  const result = await sendCommandAndWait(id, {
    request_id: crypto.randomUUID(),
    type: "list_files",
    payload: { path, nfs_home: nfsHome },
  }, 15_000) as any;

  // Agent returns {type: "error"} on failure — surface it properly.
  if (result?.type === "error") {
    return NextResponse.json(
      { error: result.payload?.error ?? "Failed to list files" },
      { status: 500 }
    );
  }

  return NextResponse.json(result);
}
