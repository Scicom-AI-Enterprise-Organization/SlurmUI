import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  readMetricsConfig,
  mergeMetricsConfig,
  listStackHostCandidates,
  type ExporterMode,
} from "@/lib/metrics-config";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const cfg = (cluster.config ?? {}) as Record<string, unknown>;
  const metrics = readMetricsConfig(cfg);
  const hostsEntries = (cfg.slurm_hosts_entries ?? []) as Array<{
    hostname: string;
    ip: string;
  }>;

  const latestTask = await prisma.backgroundTask.findFirst({
    where: { clusterId: id, type: { startsWith: "metrics_" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, status: true, createdAt: true },
  });

  return NextResponse.json({
    metrics,
    hosts: hostsEntries.map((h) => ({ hostname: h.hostname, ip: h.ip })),
    stackHostCandidates: listStackHostCandidates(cfg),
    controllerHost: cluster.controllerHost,
    latestTask,
  });
}

export async function PUT(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const patch: Partial<{
    enabled: boolean;
    exporterMode: ExporterMode;
    prometheusPort: number;
    grafanaPort: number;
    retention: string;
    stackHost: string;
    stackDataPath: string;
  }> = {};

  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (body.exporterMode === "auto" || body.exporterMode === "dcgm" || body.exporterMode === "nvidia_smi") {
    patch.exporterMode = body.exporterMode;
  }
  if (Number.isInteger(body.prometheusPort) && body.prometheusPort > 0 && body.prometheusPort < 65536) {
    patch.prometheusPort = body.prometheusPort;
  }
  if (Number.isInteger(body.grafanaPort) && body.grafanaPort > 0 && body.grafanaPort < 65536) {
    patch.grafanaPort = body.grafanaPort;
  }
  if (typeof body.retention === "string" && /^\d+[smhdwy]$/.test(body.retention)) {
    patch.retention = body.retention;
  }
  if (typeof body.stackHost === "string" && body.stackHost.trim()) {
    patch.stackHost = body.stackHost.trim();
  }
  if (typeof body.stackDataPath === "string") {
    const v = body.stackDataPath.trim();
    if (v === "" || /^\/[A-Za-z0-9_./-]+$/.test(v)) {
      patch.stackDataPath = v;
    } else {
      return NextResponse.json({ error: "Invalid stack data path" }, { status: 400 });
    }
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const next = mergeMetricsConfig(cluster.config, patch);
  await prisma.cluster.update({
    where: { id },
    data: { config: next as never },
  });

  await logAudit({
    action: "metrics.config.update",
    entity: "Cluster",
    entityId: id,
    metadata: patch,
  });

  return NextResponse.json({ metrics: readMetricsConfig(next) });
}
