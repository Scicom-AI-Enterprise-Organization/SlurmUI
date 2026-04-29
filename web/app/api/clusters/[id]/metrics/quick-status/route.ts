/**
 * Lightweight liveness probe for the cluster's Prometheus, scoped wider
 * than `/metrics/status` so non-admin job owners can use it from the
 * Job detail "Expose metrics" tab to know whether their toggle has any
 * chance of doing anything.
 *
 * Returns `{ enabled, prometheusUp }`. `enabled` reflects whether the
 * stack has been configured at all; `prometheusUp` is the live curl
 * probe against /-/ready on the stack host.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple, getClusterSshTarget } from "@/lib/ssh-exec";
import { readMetricsConfig, resolveStackHost } from "@/lib/metrics-config";

interface RouteParams { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  // Authorise: admin OR a member with at least one Job in this cluster
  // (covers job authors who land on the Expose tab).
  const role = (session.user as { role?: string }).role;
  if (role !== "ADMIN") {
    const userId = (session.user as { id?: string }).id;
    if (!userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const cu = await prisma.clusterUser.findFirst({
      where: { clusterId: id, userId, status: "ACTIVE" as const },
      select: { id: true },
    });
    const ownsJob = await prisma.job.findFirst({
      where: { clusterId: id, userId },
      select: { id: true },
    });
    if (!cu && !ownsJob) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const metrics = readMetricsConfig(config);
  if (!metrics.enabled) {
    return NextResponse.json({ enabled: false, prometheusUp: false });
  }
  if (!cluster.sshKey || cluster.connectionMode !== "SSH") {
    return NextResponse.json({ enabled: true, prometheusUp: false, reason: "Cluster not in SSH mode" });
  }

  const target = await getClusterSshTarget(id);
  if (!target) return NextResponse.json({ enabled: true, prometheusUp: false, reason: "No SSH target" });
  const tgt = { ...target, bastion: cluster.sshBastion };

  const stack = resolveStackHost(cluster.controllerHost, config, metrics);
  const stackIp = stack.isController ? "127.0.0.1" : stack.ip;
  const cmd = `curl -s -o /dev/null -w '%{http_code}\\n' --max-time 3 http://${stackIp}:${metrics.prometheusPort}/-/ready 2>/dev/null || echo "000"`;
  const r = await sshExecSimple(tgt, cmd);
  const code = (r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "000").slice(0, 3);
  return NextResponse.json({
    enabled: true,
    prometheusUp: code === "200",
    code,
  });
}
