import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ id: string; templateId: string }> }

async function loadOwned(templateId: string, userId: string) {
  const t = await prisma.jobTemplate.findUnique({ where: { id: templateId } });
  if (!t || t.userId !== userId) return null;
  return t;
}

// GET — full template (script included).
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { templateId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const t = await loadOwned(templateId, session.user.id);
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(t);
}

// PATCH — rename / edit script / change partition / update description.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { templateId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const t = await loadOwned(templateId, session.user.id);
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const data: Record<string, unknown> = {};
  if (typeof body.name === "string") data.name = body.name.trim();
  if (typeof body.description === "string") data.description = body.description.trim() || null;
  if (typeof body.script === "string") {
    data.script = body.script;
    // Keep the denormalized partition column in sync with what the script says.
    const m = body.script.match(/#SBATCH\s+(?:--partition|-p)[=\s]+(\S+)/);
    if (!m) {
      return NextResponse.json(
        { error: "Script must include '#SBATCH --partition=<name>'" },
        { status: 400 }
      );
    }
    data.partition = m[1];
  }

  try {
    const updated = await prisma.jobTemplate.update({ where: { id: templateId }, data });
    return NextResponse.json(updated);
  } catch (e: any) {
    if (e?.code === "P2002") {
      return NextResponse.json({ error: "A template with this name already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: e?.message ?? "Failed to update" }, { status: 500 });
  }
}

// DELETE — remove.
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { templateId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const t = await loadOwned(templateId, session.user.id);
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.jobTemplate.delete({ where: { id: templateId } });
  return NextResponse.json({ ok: true });
}
