import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { randomUUID } from "crypto";
import { probeClusterHealth, effectiveClusterStatus } from "@/lib/cluster-health";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clusters = await prisma.cluster.findMany({
    select: {
      id: true,
      name: true,
      controllerHost: true,
      status: true,
      // `config` carries the health blob the effective-status helper reads.
      config: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { jobs: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  for (const c of clusters) probeClusterHealth(c.id);

  // Trust the probe's latest result over the stale DB status column.
  const out = clusters.map(({ config, ...c }) => ({
    ...c,
    status: effectiveClusterStatus({ status: c.status, config }),
  }));

  return NextResponse.json(out);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { name, controllerHost, connectionMode, natsUrl, sshKeyId, sshUser, sshPort, sshJumpHost, sshJumpUser, sshJumpPort, sshJumpKeyId, sshProxyCommand, sshJumpProxyCommand } = body;
  if (!name || !controllerHost) {
    return NextResponse.json(
      { error: "Missing required fields: name, controllerHost" },
      { status: 400 }
    );
  }

  const mode = connectionMode === "SSH" ? "SSH" : "NATS";
  if (mode === "NATS" && !natsUrl) {
    return NextResponse.json({ error: "NATS URL is required for NATS mode" }, { status: 400 });
  }

  // Validate SSH key exists
  if (sshKeyId) {
    const sshKey = await prisma.sshKey.findUnique({ where: { id: sshKeyId } });
    if (!sshKey) {
      return NextResponse.json({ error: "SSH key not found" }, { status: 400 });
    }
  } else {
    const keyCount = await prisma.sshKey.count();
    if (keyCount === 0) {
      return NextResponse.json(
        { error: "No SSH keys configured. Go to Admin Settings and add an SSH key first." },
        { status: 412 },
      );
    }
  }

  const existing = await prisma.cluster.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json(
      { error: `Cluster with name "${name}" already exists` },
      { status: 409 }
    );
  }

  const installToken = randomUUID();
  const installTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  try {
    const cluster = await prisma.cluster.create({
      data: {
        name,
        controllerHost,
        connectionMode: mode,
        natsUrl: natsUrl || null,
        natsCredentials: "",
        sshUser: sshUser || "root",
        sshPort: sshPort || 22,
        sshJumpHost: sshJumpHost || null,
        sshJumpUser: sshJumpHost ? (sshJumpUser || "root") : null,
        sshJumpPort: sshJumpHost ? (sshJumpPort || 22) : null,
        sshJumpKeyId: sshJumpHost && sshJumpKeyId ? sshJumpKeyId : null,
        sshProxyCommand: sshProxyCommand || null,
        sshJumpProxyCommand: sshJumpProxyCommand || null,
        status: "PROVISIONING",
        config: { slurm_cluster_name: name, slurm_controller_host: controllerHost },
        installToken,
        installTokenExpiresAt,
        ...(sshKeyId ? { sshKeyId } : {}),
      },
    });

    await logAudit({
      action: "cluster.create",
      entity: "Cluster",
      entityId: cluster.id,
      metadata: { name, controllerHost, connectionMode: mode },
    });

    return NextResponse.json(cluster, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown database error";
    console.error("[clusters POST] create failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
