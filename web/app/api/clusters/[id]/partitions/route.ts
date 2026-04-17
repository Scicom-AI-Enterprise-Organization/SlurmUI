import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ id: string }> }

export interface Partition {
  name: string;
  default?: boolean;
  nodes: string; // "ALL" or comma-separated hostnames
  max_time?: string; // e.g. "INFINITE", "1-00:00:00"
  state?: string; // UP, DOWN, DRAIN, INACTIVE
}

function validate(parts: Partition[]): string | null {
  if (!Array.isArray(parts)) return "partitions must be an array";
  const names = new Set<string>();
  for (const p of parts) {
    if (!p?.name || !/^[a-zA-Z0-9_-]+$/.test(p.name)) return `Invalid partition name: ${p?.name}`;
    if (names.has(p.name)) return `Duplicate partition name: ${p.name}`;
    names.add(p.name);
    if (typeof p.nodes !== "string" || p.nodes.length === 0) return `Partition ${p.name} has no nodes`;
  }
  const defaults = parts.filter((p) => p.default);
  if (defaults.length > 1) return "Only one partition can be default";
  return null;
}

// GET — list partitions from cluster.config
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = cluster.config as Record<string, unknown>;
  const partitions = (config.slurm_partitions ?? []) as Partition[];
  const hostsEntries = (config.slurm_hosts_entries ?? []) as Array<{ hostname: string }>;
  const nodes = hostsEntries.map((h) => h.hostname);
  return NextResponse.json({ partitions, nodes });
}

// PUT — save partitions in cluster.config (without applying to slurm.conf)
export async function PUT(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json();
  const partitions: Partition[] = body.partitions ?? [];
  const err = validate(partitions);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = cluster.config as Record<string, unknown>;
  await prisma.cluster.update({
    where: { id },
    data: { config: { ...config, slurm_partitions: partitions } as any },
  });

  return NextResponse.json({ partitions });
}
