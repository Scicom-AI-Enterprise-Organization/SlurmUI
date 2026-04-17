import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { REDACTION_MASK } from "@/lib/redact-config";

interface RouteParams { params: Promise<{ id: string }> }

interface EnvVar {
  key: string;
  value: string;
  secret?: boolean;
}

function redactVar(v: EnvVar): EnvVar {
  if (v.secret && v.value) return { ...v, value: REDACTION_MASK };
  return v;
}

// GET — list tracked env vars (secrets masked).
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = cluster.config as Record<string, unknown>;
  const vars = ((config.os_environment as EnvVar[]) ?? []).map(redactVar);

  const latestTask = await prisma.backgroundTask.findFirst({
    where: { clusterId: id, type: "apply_environment" },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, createdAt: true },
  });

  return NextResponse.json({ vars, latestTask });
}

// PUT — save env var list. Masked values preserve whatever is in the DB.
export async function PUT(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const incoming: EnvVar[] = body.vars ?? [];
  if (!Array.isArray(incoming)) {
    return NextResponse.json({ error: "vars must be an array" }, { status: 400 });
  }

  // Validate keys.
  for (const v of incoming) {
    if (!v.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) {
      return NextResponse.json({ error: `Invalid env var name: ${v.key}` }, { status: 400 });
    }
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = cluster.config as Record<string, unknown>;
  const existing = ((config.os_environment as EnvVar[]) ?? []);
  const existingByKey = new Map(existing.map((v) => [v.key, v]));

  const merged: EnvVar[] = incoming.map((v) => {
    const prior = existingByKey.get(v.key);
    // If the client sent the mask back, keep the stored value.
    if (v.secret && prior && v.value === REDACTION_MASK) {
      return { ...v, value: prior.value };
    }
    return { key: v.key, value: v.value ?? "", secret: !!v.secret };
  });

  await prisma.cluster.update({
    where: { id },
    data: { config: { ...config, os_environment: merged } as any },
  });

  return NextResponse.json({ vars: merged.map(redactVar) });
}
