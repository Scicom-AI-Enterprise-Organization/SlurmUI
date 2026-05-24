/**
 * POST /api/clusters/[id]/users/adopt-orphans
 *
 * Body: { usernames: string[] }
 *
 * For each unix username that has no matching Aura User row, create a
 * placeholder USER-role user and link it as an ACTIVE ClusterUser on
 * this cluster. Designed to be triggered from the Jobs page's
 * "Sync from Slurm" result dialog when orphan unix users show up so
 * the next sync can attribute their jobs.
 *
 * Same logic the import-from-slurm route runs inline — extracted here
 * so the UI can adopt without re-running the full sacct fetch.
 *
 * Bearer-auth + admin only. Idempotent — re-running it for an already-
 * adopted username is a no-op (returns `adopted: 0`).
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple, getClusterSshTarget } from "@/lib/ssh-exec";
import { logAudit } from "@/lib/audit";

interface RouteParams { params: Promise<{ id: string }> }

// Same shape as the User row that import-from-slurm creates inline —
// kept in one place so a future schema change only needs one edit.
function buildPlaceholderUser(unixUsername: string, clusterId: string, uid?: number, gid?: number) {
  return {
    keycloakId: `imported:slurm:${unixUsername}`,
    email: `${unixUsername}+imported.${clusterId.slice(0, 8)}@aura.local`,
    name: unixUsername,
    unixUsername,
    unixUid: uid,
    unixGid: gid,
    role: "VIEWER" as const,
  };
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const rawNames = Array.isArray(body.usernames) ? body.usernames : [];
  // Sanitise — POSIX login names plus a generous allow-list. Drop blanks
  // and silently filter anything that doesn't look like a username so the
  // caller can pass through whatever sacct emitted without pre-cleaning.
  const usernames = Array.from(new Set(
    rawNames
      .filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
      .map((u: string) => u.trim())
      .filter((u: string) => /^[A-Za-z_][A-Za-z0-9._-]*$/.test(u)),
  ));
  if (usernames.length === 0) {
    return NextResponse.json({ error: "No usernames to adopt" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  // Probe the cluster for each username's uid/gid in a single SSH
  // round-trip. Same pattern as the import route. Best-effort — if
  // getent fails or the username is unknown on the controller, we
  // still create the placeholder with null uid/gid (history-only).
  const uidByName = new Map<string, { uid: number; gid: number }>();
  const target = await getClusterSshTarget(id);
  if (target) {
    const script = usernames.map((u) => `getent passwd "${u}" || echo "${u}: notfound"`).join("\n");
    const r = await sshExecSimple({ ...target, bastion: cluster.sshBastion }, script);
    if (r.success) {
      for (const line of r.stdout.split("\n")) {
        const m = line.match(/^([A-Za-z0-9._-]+):x:(\d+):(\d+):/);
        if (m) uidByName.set(m[1], { uid: parseInt(m[2], 10), gid: parseInt(m[3], 10) });
      }
    }
  }

  let adopted = 0;
  let alreadyExisted = 0;
  const failures: Array<{ username: string; error: string }> = [];

  for (const uname of usernames) {
    const idents = uidByName.get(uname);
    try {
      // upsert keyed on the unique unixUsername — concurrent requests
      // (or a prior Adopt action on the Users tab) won't duplicate.
      const existed = await prisma.user.findUnique({
        where: { unixUsername: uname },
        select: { id: true },
      });
      const user = await prisma.user.upsert({
        where: { unixUsername: uname },
        update: {},
        create: buildPlaceholderUser(uname, id, idents?.uid, idents?.gid),
        select: { id: true },
      });
      if (existed) alreadyExisted++;
      else adopted++;
      // Always upsert the ClusterUser link, even when the User already
      // existed — they might be a real Aura user who hasn't been
      // provisioned to this cluster yet. status=ACTIVE matches what
      // the Users-tab Adopt action does.
      await prisma.clusterUser.upsert({
        where: { userId_clusterId: { userId: user.id, clusterId: id } },
        update: { status: "ACTIVE", provisionedAt: new Date() },
        create: {
          userId: user.id,
          clusterId: id,
          status: "ACTIVE",
          provisionedAt: new Date(),
        },
      });
    } catch (e) {
      failures.push({
        username: uname,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  await logAudit({
    action: "users.adopt_orphans",
    entity: "Cluster",
    entityId: id,
    metadata: { requested: usernames.length, adopted, alreadyExisted, failed: failures.length },
  });

  return NextResponse.json({
    requested: usernames.length,
    adopted,
    alreadyExisted,
    failures,
  });
}
