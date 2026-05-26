/**
 * GitHub code credentials for a cluster — MULTIPLE entries.
 *
 * Stored under cluster.config.code_credentials.github as an array, so an
 * admin can register more than one PAT (e.g. one for "team repos", one
 * for "personal experiments", one with broader scopes for CI mirrors).
 * Each job picks one at submit time, same UX as the experiment-tracker
 * selector on /jobs/new.
 *
 * Entry shape (JSONB):
 *   { id, name, username?, token, createdAt, updatedAt }
 *
 * Routes:
 *   GET    /…/github               — list (tokens redacted; returns `hasToken: true`)
 *   POST   /…/github               — create a new entry
 *   PATCH  /…/github/[credId]      — update name / username / rotate token
 *   DELETE /…/github/[credId]      — remove one entry
 *
 * Auth: Bearer aura_* (admin only) — same shape as /integrations.
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { readGithubCredsList, type GithubCred } from "@/lib/git-credentials";
import { randomBytes } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

function newId(): string {
  return `gh-${randomBytes(8).toString("hex")}`;
}

function redact(creds: GithubCred[]): Array<Omit<GithubCred, "token"> & { hasToken: true }> {
  return creds.map(({ token: _t, ...rest }) => ({ ...rest, hasToken: true }));
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    select: { config: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  return NextResponse.json({ credentials: redact(readGithubCredsList(cluster.config)) });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "";
  const username =
    typeof body.username === "string" && body.username.trim()
      ? body.username.trim()
      : undefined;
  const token = typeof body.token === "string" ? body.token : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!token || token.length < 8) {
    return NextResponse.json(
      { error: "token is required (must be a personal access token, ≥8 chars)" },
      { status: 400 },
    );
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const existing = readGithubCredsList(cluster.config);
  if (existing.some((e) => e.name === name)) {
    return NextResponse.json(
      { error: `A GitHub credential named '${name}' already exists on this cluster.` },
      { status: 409 },
    );
  }

  const config = (cluster.config as Record<string, unknown>) ?? {};
  const cc = ((config.code_credentials as Record<string, unknown>) ?? {});
  const now = new Date().toISOString();
  const next: GithubCred = { id: newId(), name, username, token, createdAt: now };
  const updated = [...existing, next];
  await prisma.cluster.update({
    where: { id },
    data: {
      config: {
        ...config,
        code_credentials: { ...cc, github: updated },
      } as never,
    },
  });

  await logAudit({
    action: "code_credentials.github.create",
    entity: "Cluster",
    entityId: id,
    metadata: { name, hasUsername: !!username },
  });

  const { token: _t, ...safe } = next;
  return NextResponse.json({ credential: { ...safe, hasToken: true } }, { status: 201 });
}
