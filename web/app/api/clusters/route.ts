import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

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
      createdAt: true,
      updatedAt: true,
      _count: { select: { jobs: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(clusters);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { name, controllerHost } = body;
  if (!name || !controllerHost) {
    return NextResponse.json(
      { error: "Missing required fields: name, controllerHost" },
      { status: 400 }
    );
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

  const cluster = await prisma.cluster.create({
    data: {
      name,
      controllerHost,
      natsCredentials: "",
      status: "PROVISIONING",
      config: { slurm_cluster_name: name, slurm_controller_host: controllerHost },
      installToken,
      installTokenExpiresAt,
    },
  });

  return NextResponse.json(cluster, { status: 201 });
}
