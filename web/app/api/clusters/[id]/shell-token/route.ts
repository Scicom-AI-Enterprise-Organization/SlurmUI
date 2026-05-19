import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getApiUser } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit";
import { mintShellSession } from "@/lib/cluster-shell";

interface RouteParams { params: Promise<{ id: string }> }

// POST /api/clusters/[id]/shell-token — issue a one-time session id used to
// open the PTY stream at /api/cluster-shell/[sessionId]/stream. Admin only.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    select: { id: true, sshKeyId: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKeyId) {
    return NextResponse.json({ error: "No SSH key assigned" }, { status: 412 });
  }

  let nodeIp: string | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as { nodeIp?: unknown };
    if (typeof body.nodeIp === "string" && body.nodeIp.length > 0) {
      nodeIp = body.nodeIp;
    }
  } catch {}

  let sessionId: string;
  try {
    sessionId = mintShellSession(user.id, id, nodeIp);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  await logAudit({
    action: "cluster.shell.open",
    entity: "Cluster",
    entityId: id,
    metadata: nodeIp ? { nodeIp } : undefined,
  });

  return NextResponse.json({ sessionId });
}
