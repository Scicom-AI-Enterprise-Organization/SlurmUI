import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/clusters — list all clusters
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
      _count: {
        select: { jobs: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(clusters);
}

// POST /api/clusters — create a new cluster (admin only)
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();

  // Validate required fields
  const { name, controllerHost, config } = body;
  if (!name || !controllerHost || !config) {
    return NextResponse.json(
      { error: "Missing required fields: name, controllerHost, config" },
      { status: 400 }
    );
  }

  // Check for duplicate name
  const existing = await prisma.cluster.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json(
      { error: `Cluster with name "${name}" already exists` },
      { status: 409 }
    );
  }

  const cluster = await prisma.cluster.create({
    data: {
      name,
      controllerHost,
      natsCredentials: "", // populated during bootstrap
      status: "PROVISIONING",
      config,
    },
  });

  return NextResponse.json(cluster, { status: 201 });
}
