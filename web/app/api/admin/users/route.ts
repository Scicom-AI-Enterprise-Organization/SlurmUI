import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Richer user directory for the organization admin page. Kept separate
// from /api/users so existing callers (user-picker dropdowns etc.) keep
// their lean shape.
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true, email: true, name: true, role: true,
      unixUsername: true, unixUid: true, emailVerified: true,
      keycloakId: true, passwordHash: true, createdAt: true,
      _count: { select: { clusters: true } },
    },
  });

  return NextResponse.json(
    users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      unixUsername: u.unixUsername,
      unixUid: u.unixUid,
      emailVerified: u.emailVerified,
      provider: u.keycloakId?.startsWith("local:") ? "local" : "keycloak",
      hasPassword: !!u.passwordHash,
      clusterCount: u._count.clusters,
      createdAt: u.createdAt,
    }))
  );
}
