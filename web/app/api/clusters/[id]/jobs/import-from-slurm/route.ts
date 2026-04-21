import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecSimple } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

// Map Slurm job states (squeue %T) onto our JobStatus enum. Anything we
// don't explicitly recognise falls through as PENDING so the row still
// shows up in the UI and the background watcher can correct it later.
function mapState(state: string): "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" {
  const s = state.toUpperCase();
  if (s === "RUNNING" || s === "COMPLETING") return "RUNNING";
  if (s === "COMPLETED") return "COMPLETED";
  if (s === "FAILED" || s === "NODE_FAIL" || s === "TIMEOUT" || s === "OUT_OF_MEMORY") return "FAILED";
  if (s === "CANCELLED" || s === "CANCELLED+") return "CANCELLED";
  return "PENDING";
}

// POST /api/clusters/[id]/jobs/import-from-slurm
// Pulls the live queue via squeue on the controller and upserts any Slurm
// jobs that aren't already in our DB. Useful after a DB reset, or when jobs
// were submitted via the CLI outside SlurmUI. Does NOT touch jobs that are
// already tracked (matched by clusterId + slurmJobId).
export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (cluster.connectionMode !== "SSH" || !cluster.sshKey) {
    return NextResponse.json({ error: "SSH-only endpoint — NATS clusters sync via agent" }, { status: 412 });
  }

  // squeue format:
  //   %i = job id, %T = state, %u = user, %P = partition, %j = job name,
  //   %V = submit time (ISO-ish), %M = elapsed.
  // `--array` expands array jobs into their individual tasks.
  const FIELD_SEP = "|";
  const squeueCmd = `squeue --array -h -o "%i${FIELD_SEP}%T${FIELD_SEP}%u${FIELD_SEP}%P${FIELD_SEP}%j${FIELD_SEP}%V" 2>&1`;

  const sshRes = await sshExecSimple(
    {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
      jumpHost: cluster.sshJumpHost,
      jumpUser: cluster.sshJumpUser,
      jumpPort: cluster.sshJumpPort,
      proxyCommand: cluster.sshProxyCommand,
      jumpProxyCommand: cluster.sshJumpProxyCommand,
    },
    squeueCmd,
  );

  if (!sshRes.success) {
    return NextResponse.json({
      error: `squeue failed: ${sshRes.stderr.trim() || sshRes.stdout.trim() || `exit ${sshRes.exitCode}`}`,
    }, { status: 502 });
  }

  const lines = sshRes.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  // Filter out ssh banner / error lines — squeue rows all have 5 separators.
  const rows = lines
    .filter((l) => (l.match(/\|/g)?.length ?? 0) === 5)
    .map((l) => {
      const [sjid, state, user, partition, name, submit] = l.split(FIELD_SEP);
      return {
        slurmJobId: parseInt(sjid, 10),
        state: (state || "").trim(),
        user: (user || "").trim(),
        partition: (partition || "").trim() || "main",
        name: (name || "").trim(),
        submit: (submit || "").trim(),
      };
    })
    .filter((r) => Number.isFinite(r.slurmJobId) && r.slurmJobId > 0);

  // Lookup existing + users once.
  const existingRows = await prisma.job.findMany({
    where: { clusterId: id, slurmJobId: { in: rows.map((r) => r.slurmJobId) } },
    select: { slurmJobId: true },
  });
  const existing = new Set(existingRows.map((e) => e.slurmJobId!));

  const unixNames = Array.from(new Set(rows.map((r) => r.user).filter(Boolean)));
  const users = await prisma.user.findMany({
    where: { unixUsername: { in: unixNames } },
    select: { id: true, unixUsername: true },
  });
  const userByUnix = new Map(users.map((u) => [u.unixUsername!, u.id]));

  let imported = 0;
  let skippedExisting = 0;
  let skippedNoUser = 0;
  const orphans: Array<{ slurmJobId: number; user: string }> = [];

  for (const r of rows) {
    if (existing.has(r.slurmJobId)) { skippedExisting++; continue; }
    const userId = userByUnix.get(r.user);
    if (!userId) {
      skippedNoUser++;
      orphans.push({ slurmJobId: r.slurmJobId, user: r.user });
      continue;
    }

    // Submit time from squeue is local-ish ISO; falling back to now() keeps
    // things finite if parsing fails. Slurm emits "YYYY-MM-DDTHH:MM:SS".
    const createdAt = r.submit && !isNaN(Date.parse(r.submit)) ? new Date(r.submit) : new Date();

    await prisma.job.create({
      data: {
        clusterId: id,
        userId,
        slurmJobId: r.slurmJobId,
        script: `# Imported from Slurm — original script not captured.\n# Job name: ${r.name}\n`,
        partition: r.partition,
        status: mapState(r.state),
        createdAt,
      },
    }).catch(() => { /* race: another import ran in parallel */ });
    imported++;
  }

  await logAudit({
    action: "jobs.import_from_slurm",
    entity: "Cluster",
    entityId: id,
    metadata: { imported, skippedExisting, skippedNoUser, total: rows.length },
  });

  return NextResponse.json({
    total: rows.length,
    imported,
    skippedExisting,
    skippedNoUser,
    orphans: orphans.slice(0, 20),
  });
}
