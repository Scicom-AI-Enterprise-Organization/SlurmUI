import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ id: string }> }

// GET — list the caller's templates for this cluster.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const templates = await prisma.jobTemplate.findMany({
    where: { clusterId: id, userId: session.user.id },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({ templates });
}

// POST — create a new template.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const name = (body.name ?? "").trim();
  const script = (body.script ?? "").trim();
  const description = (body.description ?? "").trim() || null;

  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!script) return NextResponse.json({ error: "Script is required" }, { status: 400 });

  // Partition lives inside the script (#SBATCH --partition=...). Extract it so
  // we can index templates by partition without asking the user twice.
  const m = script.match(/#SBATCH\s+(?:--partition|-p)[=\s]+(\S+)/);
  if (!m) {
    return NextResponse.json(
      { error: "Script must include '#SBATCH --partition=<name>'" },
      { status: 400 }
    );
  }
  const partition = m[1];

  try {
    const template = await prisma.jobTemplate.create({
      data: { clusterId: id, userId: session.user.id, name, script, partition, description },
    });
    return NextResponse.json(template, { status: 201 });
  } catch (e: any) {
    if (e?.code === "P2002") {
      return NextResponse.json({ error: "A template with this name already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: e?.message ?? "Failed to create" }, { status: 500 });
  }
}
