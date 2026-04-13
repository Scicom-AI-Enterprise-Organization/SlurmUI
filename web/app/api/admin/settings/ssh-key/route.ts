import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshPublicKeyFromPrivate } from "@/lib/ssh-key";
import type { Session } from "next-auth";

function isAdmin(session: Session | null): boolean {
  return !!session?.user && (session.user as any).role === "ADMIN";
}

// GET /api/admin/settings/ssh-key
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [priv, pub] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "ssh_private_key" } }),
    prisma.setting.findUnique({ where: { key: "ssh_public_key" } }),
  ]);

  return NextResponse.json({
    configured: !!priv,
    publicKey: pub?.value ?? null,
  });
}

// PUT /api/admin/settings/ssh-key
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { privateKey } = await req.json();
  if (!privateKey || typeof privateKey !== "string" || privateKey.trim() === "") {
    return NextResponse.json({ error: "privateKey is required" }, { status: 400 });
  }

  let publicKey: string;
  try {
    publicKey = sshPublicKeyFromPrivate(privateKey.trim());
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 422 });
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.setting.upsert({
      where: { key: "ssh_private_key" },
      create: { key: "ssh_private_key", value: privateKey.trim(), updatedAt: now },
      update: { value: privateKey.trim(), updatedAt: now },
    }),
    prisma.setting.upsert({
      where: { key: "ssh_public_key" },
      create: { key: "ssh_public_key", value: publicKey, updatedAt: now },
      update: { value: publicKey, updatedAt: now },
    }),
  ]);

  return NextResponse.json({ configured: true, publicKey });
}

// DELETE /api/admin/settings/ssh-key
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  await prisma.setting.deleteMany({
    where: { key: { in: ["ssh_private_key", "ssh_public_key"] } },
  });

  return NextResponse.json({ configured: false, publicKey: null });
}
