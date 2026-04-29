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
  //   %V = submit time, %C = CPUs allocated.
  // We deliberately don't use %b (TresPerNode) or %G (Gres) for GPU info
  // because Slurm 23+ does NOT surface gres/gpu in those fields when the
  // job uses --gres=gpu:N — the count lives in JOB_GRES which only
  // scontrol exposes. We piggyback a `scontrol show job <ids>` call after
  // the squeue list to grab JOB_GRES for every running/pending job.
  // `--array` expands array jobs into their individual tasks.
  const FIELD_SEP = "|";
  const squeueCmd = `squeue --array -h -o "%i${FIELD_SEP}%T${FIELD_SEP}%u${FIELD_SEP}%P${FIELD_SEP}%j${FIELD_SEP}%V${FIELD_SEP}%C" 2>&1`;

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
  // Filter out ssh banner / error lines — squeue rows all have 6 separators
  // now (7 fields: jobid, state, user, partition, name, submit, cpus).
  const rows = lines
    .filter((l) => (l.match(/\|/g)?.length ?? 0) === 6)
    .map((l) => {
      const [sjid, state, user, partition, name, submit, cpus] = l.split(FIELD_SEP);
      return {
        slurmJobId: parseInt(sjid, 10),
        state: (state || "").trim(),
        user: (user || "").trim(),
        partition: (partition || "").trim() || "main",
        name: (name || "").trim(),
        submit: (submit || "").trim(),
        cpus: parseInt((cpus || "").trim(), 10) || 1,
        gpus: 0, // filled in below from scontrol's JOB_GRES line
      };
    })
    .filter((r) => Number.isFinite(r.slurmJobId) && r.slurmJobId > 0);

  // Fan out one scontrol call per job in a single SSH round-trip and
  // parse JOB_GRES=gpu:N — the only place Slurm 23+ reliably exposes the
  // GPU count for jobs that requested --gres=gpu:N (squeue's %b / %G
  // come back empty on these versions; AllocTRES doesn't include gres).
  if (rows.length > 0) {
    const ids = rows.map((r) => r.slurmJobId).join(" ");
    const gresCmd = `for J in ${ids}; do
  scontrol show job "$J" 2>/dev/null | awk -v J="$J" 'match($0, /JOB_GRES=([^ ]+)/, m){print J"|"m[1]; exit}'
done`;
    const gresRes = await sshExecSimple(
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
      gresCmd,
    );
    if (gresRes.success) {
      const gpuById = new Map<number, number>();
      for (const line of gresRes.stdout.split("\n")) {
        // Format: "<jobid>|gpu:N" or "<jobid>|gpu:tesla:N" or empty if no gres.
        const m = line.trim().match(/^(\d+)\|gpu(?::[A-Za-z0-9_-]+)?:(\d+)$/);
        if (m) gpuById.set(parseInt(m[1], 10), parseInt(m[2], 10));
      }
      for (const r of rows) {
        const g = gpuById.get(r.slurmJobId);
        if (g) r.gpus = g;
      }
    }
  }

  // Lookup existing + users once. Also pull the stored script so we can
  // backfill `#SBATCH --cpus-per-task` / `--gres=gpu:N` lines into rows
  // that were imported before this code added them — otherwise the
  // dashboard's GPU-hours stat keeps showing 0 for jobs that have been
  // running for days.
  const existingRows = await prisma.job.findMany({
    where: { clusterId: id, slurmJobId: { in: rows.map((r) => r.slurmJobId) } },
    select: { id: true, slurmJobId: true, script: true },
  });
  const existing = new Map(existingRows.map((e) => [e.slurmJobId!, e]));

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

  let backfilled = 0;
  for (const r of rows) {
    const existingJob = existing.get(r.slurmJobId);
    if (existingJob) {
      // Backfill: if the stored script is missing GPU/CPU directives but
      // the live squeue row has them, update in place. No-op once it has
      // been done. Saves the user from re-importing everything.
      const lacksCpu = !/^#SBATCH\s+(?:--cpus-per-task|-c)[=\s]/m.test(existingJob.script);
      const lacksGpu = !/^#SBATCH\s+--gres=gpu/m.test(existingJob.script);
      const hasCpuToAdd = lacksCpu && r.cpus > 1;
      const hasGpuToAdd = lacksGpu && r.gpus > 0;
      if (hasCpuToAdd || hasGpuToAdd) {
        const additions: string[] = [];
        if (hasCpuToAdd) additions.push(`#SBATCH --cpus-per-task=${r.cpus}`);
        if (hasGpuToAdd) additions.push(`#SBATCH --gres=gpu:${r.gpus}`);
        await prisma.job.update({
          where: { id: existingJob.id },
          data: { script: `${existingJob.script.replace(/\n+$/, "")}\n${additions.join("\n")}\n` },
        }).catch(() => {});
        backfilled++;
      }
      skippedExisting++;
      continue;
    }
    const userId = userByUnix.get(r.user);
    if (!userId) {
      skippedNoUser++;
      orphans.push({ slurmJobId: r.slurmJobId, user: r.user });
      continue;
    }

    // Submit time from squeue is local-ish ISO; falling back to now() keeps
    // things finite if parsing fails. Slurm emits "YYYY-MM-DDTHH:MM:SS".
    const createdAt = r.submit && !isNaN(Date.parse(r.submit)) ? new Date(r.submit) : new Date();

    // Build a synthetic placeholder script with #SBATCH directives so the
    // dashboard's compute-consumed parser (parseJobGresCpus) can extract
    // CPU + GPU counts. Without these lines, parser falls back to cpus=1,
    // gpus=0 and GPU-hours stays at zero forever.
    const scriptLines = [
      `# Imported from Slurm — original script not captured.`,
      `# Job name: ${r.name}`,
      `#SBATCH --job-name=${r.name || `slurm-${r.slurmJobId}`}`,
      `#SBATCH --cpus-per-task=${r.cpus}`,
    ];
    // r.gpus comes from the scontrol JOB_GRES scrape above (Slurm 23+
    // doesn't surface gres in squeue %b / %G or sacct AllocTRES).
    if (r.gpus > 0) {
      scriptLines.push(`#SBATCH --gres=gpu:${r.gpus}`);
    }
    const script = scriptLines.join("\n") + "\n";

    await prisma.job.create({
      data: {
        clusterId: id,
        userId,
        slurmJobId: r.slurmJobId,
        script,
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
    metadata: { imported, skippedExisting, skippedNoUser, backfilled, total: rows.length },
  });

  return NextResponse.json({
    total: rows.length,
    imported,
    skippedExisting,
    skippedNoUser,
    backfilled,
    orphans: orphans.slice(0, 20),
  });
}
