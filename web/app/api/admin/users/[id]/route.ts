import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

interface P { params: Promise<{ id: string }> }

// PATCH — change role or reset password. Admins can demote / promote but
// cannot demote themselves (guard against accidental lockout).
export async function PATCH(req: NextRequest, { params }: P) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({})) as { role?: "ADMIN" | "VIEWER" };

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!body.role) {
    return NextResponse.json({ error: "No changes" }, { status: 400 });
  }
  if (target.id === session.user.id && body.role !== "ADMIN") {
    return NextResponse.json({ error: "You cannot demote yourself" }, { status: 400 });
  }
  if (body.role !== "ADMIN" && body.role !== "VIEWER") {
    return NextResponse.json({ error: "Invalid role — must be ADMIN or VIEWER" }, { status: 400 });
  }

  const updated = await prisma.user.update({ where: { id }, data: { role: body.role } });
  await logAudit({
    action: "user.update",
    entity: "User",
    entityId: id,
    metadata: {
      email: target.email,
      changes: { role: { from: target.role, to: body.role } },
    },
  });
  return NextResponse.json({ ok: true, role: updated.role });
}

// DELETE — remove a user. Refuses self-deletion and users who own jobs
// (foreign-key integrity). Admins should deprovision on clusters first.
export async function DELETE(_req: NextRequest, { params }: P) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (id === session.user.id) {
    return NextResponse.json({ error: "You cannot delete yourself" }, { status: 400 });
  }
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return NextResponse.json({ ok: true });

  const jobCount = await prisma.job.count({ where: { userId: id } });
  if (jobCount > 0) {
    return NextResponse.json(
      { error: `User has ${jobCount} job(s). Delete them first or reassign.` },
      { status: 409 }
    );
  }

  await prisma.$transaction([
    prisma.clusterUser.deleteMany({ where: { userId: id } }),
    prisma.jobTemplate.deleteMany({ where: { userId: id } }),
    prisma.appSession.deleteMany({ where: { userId: id } }),
    prisma.user.delete({ where: { id } }),
  ]);

  await logAudit({
    action: "user.delete",
    entity: "User",
    entityId: id,
    metadata: { email: target.email, role: target.role },
  });
  return NextResponse.json({ ok: true });
}
