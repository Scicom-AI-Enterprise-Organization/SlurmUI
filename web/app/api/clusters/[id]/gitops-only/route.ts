import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

interface P { params: Promise<{ id: string }> }

// GET — read the per-cluster GitOps-only toggle. POST — flip it. The flag
// lives inside the cluster `config` JSON blob (no schema change needed);
// stored as `gitops_only_jobs: boolean`. When true, the submitJob helper
// rejects any call that didn't come from the GitOps reconciler.
export async function GET(_req: NextRequest, { params }: P) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cluster = await prisma.cluster.findUnique({ where: { id }, select: { config: true } });
  if (!cluster) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const cfg = (cluster.config ?? {}) as Record<string, unknown>;
  return NextResponse.json({ enabled: !!cfg.gitops_only_jobs });
}

export async function POST(req: NextRequest, { params }: P) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({})) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled (boolean) required" }, { status: 400 });
  }
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const cfg = { ...((cluster.config ?? {}) as Record<string, unknown>), gitops_only_jobs: body.enabled };
  await prisma.cluster.update({ where: { id }, data: { config: cfg } });
  await logAudit({
    action: body.enabled ? "cluster.gitops_only_enabled" : "cluster.gitops_only_disabled",
    entity: "Cluster",
    entityId: id,
    metadata: { clusterName: cluster.name },
  });
  return NextResponse.json({ enabled: body.enabled });
}
