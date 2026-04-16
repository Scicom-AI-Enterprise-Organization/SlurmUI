import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshPublicKeyFromPrivate, normaliseKey } from "@/lib/ssh-key";
import type { Session } from "next-auth";

function isAdmin(session: Session | null): boolean {
  return !!session?.user && (session.user as any).role === "ADMIN";
}

// GET /api/admin/ssh-keys — list all SSH keys (without private key)
export async function GET() {
  const session = await auth();
  if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const keys = await prisma.sshKey.findMany({
    select: {
      id: true,
      name: true,
      publicKey: true,
      createdAt: true,
      _count: { select: { clusters: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(keys);
}

// POST /api/admin/ssh-keys — create a new SSH key
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { name, privateKey } = await req.json();

  if (!name || typeof name !== "string" || name.trim() === "") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!privateKey || typeof privateKey !== "string" || privateKey.trim() === "") {
    return NextResponse.json({ error: "privateKey is required" }, { status: 400 });
  }

  const existing = await prisma.sshKey.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return NextResponse.json({ error: `SSH key "${name}" already exists` }, { status: 409 });
  }

  const normalisedKey = normaliseKey(privateKey);
  let publicKey: string;
  try {
    publicKey = sshPublicKeyFromPrivate(normalisedKey);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 422 });
  }

  const key = await prisma.sshKey.create({
    data: {
      name: name.trim(),
      privateKey: normalisedKey,
      publicKey,
    },
    select: {
      id: true,
      name: true,
      publicKey: true,
      createdAt: true,
    },
  });

  return NextResponse.json(key, { status: 201 });
}
