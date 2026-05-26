/**
 * Update / delete an individual GitHub credential entry.
 *
 * PATCH  /api/clusters/[id]/code-credentials/github/[credId]
 *   body: { name?, username?, token? }
 *   - Blank `token` keeps the existing one (rotate-without-clearing).
 *   - Pass an explicit `""` for `username` to clear.
 *   - Pass a non-empty `token` to rotate.
 *
 * DELETE /api/clusters/[id]/code-credentials/github/[credId]
 *   Removes just this entry; sibling entries (and any future code_credentials
 *   keys — gitlab/bitbucket) untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { readGithubCredsList, type GithubCred } from "@/lib/git-credentials";

interface RouteParams { params: Promise<{ id: string; credId: string }> }

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, credId } = await params;
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const list = readGithubCredsList(cluster.config);
  const idx = list.findIndex((e) => e.id === credId);
  if (idx === -1) return NextResponse.json({ error: "Credential not found" }, { status: 404 });

  const current = list[idx];
  const patch: Partial<GithubCred> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.username === "string") {
    // "" clears the field (back to falling through to `x-access-token`).
    patch.username = body.username.trim() || undefined;
  }
  // Non-empty token = rotate. Blank/missing token = keep current. We never
  // accept an explicit "clear" for token — removing the credential entirely
  // is the DELETE path.
  if (typeof body.token === "string" && body.token.length > 0) {
    if (body.token.length < 8) {
      return NextResponse.json(
        { error: "token must be at least 8 characters" },
        { status: 400 },
      );
    }
    patch.token = body.token;
  }
  // Refuse no-op PATCH so the UI never gets confused about whether a
  // request landed — caller should send at least one field.
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  // Refuse a rename that collides with another entry (mirrors POST).
  if (patch.name && list.some((e, i) => i !== idx && e.name === patch.name)) {
    return NextResponse.json(
      { error: `A GitHub credential named '${patch.name}' already exists.` },
      { status: 409 },
    );
  }

  const updated: GithubCred = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  list[idx] = updated;

  const config = (cluster.config as Record<string, unknown>) ?? {};
  const cc = ((config.code_credentials as Record<string, unknown>) ?? {});
  await prisma.cluster.update({
    where: { id },
    data: {
      config: {
        ...config,
        code_credentials: { ...cc, github: list },
      } as never,
    },
  });

  await logAudit({
    action: "code_credentials.github.update",
    entity: "Cluster",
    entityId: id,
    metadata: {
      name: updated.name,
      changed: Object.keys(patch),
      // Never echo the new token; just record whether it was rotated.
      tokenRotated: "token" in patch,
    },
  });

  const { token: _t, ...safe } = updated;
  return NextResponse.json({ credential: { ...safe, hasToken: true } });
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id, credId } = await params;
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const list = readGithubCredsList(cluster.config);
  const target = list.find((e) => e.id === credId);
  if (!target) return NextResponse.json({ error: "Credential not found" }, { status: 404 });

  const remaining = list.filter((e) => e.id !== credId);
  const config = (cluster.config as Record<string, unknown>) ?? {};
  const cc = ((config.code_credentials as Record<string, unknown>) ?? {});
  await prisma.cluster.update({
    where: { id },
    data: {
      config: {
        ...config,
        // Drop the github subkey entirely when removing the last entry so
        // /api/clusters/:id GET doesn't render an empty `github: []` blob
        // back to the config editor.
        code_credentials: remaining.length === 0
          ? Object.fromEntries(Object.entries(cc).filter(([k]) => k !== "github"))
          : { ...cc, github: remaining },
      } as never,
    },
  });

  await logAudit({
    action: "code_credentials.github.remove",
    entity: "Cluster",
    entityId: id,
    metadata: { name: target.name },
  });

  return NextResponse.json({ ok: true });
}
