import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecSimple } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

// Map Slurm job states (sacct State, squeue %T) onto our JobStatus enum.
// Anything we don't explicitly recognise falls through as PENDING so the
// row still shows up in the UI and the background watcher can correct it
// later. sacct emits "CANCELLED by <UID>" with a trailing user id — we
// take the first whitespace-separated token before mapping.
function mapState(state: string): "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" {
  const head = (state || "").toUpperCase().split(/\s+/)[0];
  if (head === "RUNNING" || head === "COMPLETING") return "RUNNING";
  if (head === "COMPLETED") return "COMPLETED";
  if (head === "FAILED" || head === "NODE_FAIL" || head === "TIMEOUT" || head === "OUT_OF_MEMORY" || head === "BOOT_FAIL" || head === "DEADLINE") return "FAILED";
  if (head === "CANCELLED" || head === "CANCELLED+") return "CANCELLED";
  if (head === "PENDING" || head === "REQUEUED" || head === "SUSPENDED" || head === "PREEMPTED") return "PENDING";
  return "PENDING";
}

// POST /api/clusters/[id]/jobs/import-from-slurm
//
// Reconciles our Job table against Slurm by querying sacct (Slurm
// accounting) on the controller. sacct returns ALL jobs Slurm has a
// record of — pending, running, completed, failed, cancelled, timed
// out — within the look-back window, so an already-tracked job that
// was cancelled outside the UI is detected and its status is updated.
//
// `squeue` was the previous backend but it only lists currently-queued
// jobs. A job cancelled in another environment leaves the queue
// instantly, so squeue could never see it and the sync silently kept
// stale RUNNING rows.
//
// For each row sacct returns:
//   - new (no clusterId+slurmJobId match)  → import with the live state
//   - existing & status changed            → update status (and exit code)
//   - existing & status unchanged          → backfill missing #SBATCH
//                                             directives only (no-op once
//                                             done)
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

  // sacct format:
  //   JobID  State  User  Partition  JobName  Submit  AllocCPUS  ExitCode
  // -X = main job only (no .batch / .extern step rows)
  // -P = parsable, fields separated by FIELD_SEP, no trailing separator
  // --noheader strips the column header line.
  // --starttime now-90days bounds the lookback to a sane window — the
  //   default is "today" which would miss anything that landed yesterday.
  // --allusers ensures we get every user's jobs, not just the SSH login
  //   account's. Requires that the SSH user has accounting read access
  //   (typical on cluster controllers — slurmdbd treats anyone with a
  //   row in qos as authorised).
  // GPU counts still come from a follow-up scontrol scrape (only works
  //   for jobs still in slurmctld memory, i.e. not-too-old terminal jobs)
  //   because Slurm 23+ doesn't put gres in any sacct field.
  const FIELD_SEP = "|";
  const sacctCmd =
    `sacct -X -P --noheader --allusers --starttime now-90days ` +
    `-o JobID,State,User,Partition,JobName,Submit,AllocCPUS,ExitCode 2>&1`;

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
    sacctCmd,
  );

  if (!sshRes.success) {
    return NextResponse.json({
      error: `sacct failed: ${sshRes.stderr.trim() || sshRes.stdout.trim() || `exit ${sshRes.exitCode}`}`,
    }, { status: 502 });
  }

  const lines = sshRes.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  // Filter out ssh banner / error lines — sacct rows have exactly 7
  // separators (8 fields: jobid, state, user, partition, name, submit,
  // cpus, exitcode).
  //
  // ALSO skip sacct rows whose Submit timestamp predates the current
  // cluster's createdAt. Why: slurmdbd's mariadb data dir persists
  // across our teardown/bootstrap cycle (teardown wipes
  // /var/spool/slurm slurmctld state but NOT the mariadb data dir, by
  // design — we don't want to drop accounting history on a controller
  // restart). On a shared backing host (managed-GPU containers, etc.)
  // a brand-new Aura cluster pointing at the same controller inherits
  // sacct rows from PREVIOUS cluster instances — and slurmctld's JobId
  // counter restarts at 1, so old "JobId=2" and new "JobId=2" collide
  // when we try to upsert by (clusterId, slurmJobId). Treating rows
  // older than cluster.createdAt as "different cluster instance, not
  // ours" cleanly avoids the cross-incarnation duplicates.
  const clusterCreatedAt = cluster.createdAt;
  let preCreatedSkipped = 0;
  const rows = lines
    .filter((l) => (l.match(/\|/g)?.length ?? 0) === 7)
    .map((l) => {
      const [sjid, state, user, partition, name, submit, cpus, exitCode] = l.split(FIELD_SEP);
      // sacct ExitCode is "rc:signal" (e.g. "0:0", "1:0", "0:9").
      const exitRc = parseInt((exitCode || "0:0").split(":")[0], 10);
      return {
        slurmJobId: parseInt(sjid, 10),
        state: (state || "").trim(),
        user: (user || "").trim(),
        partition: (partition || "").trim() || "main",
        name: (name || "").trim(),
        submit: (submit || "").trim(),
        cpus: parseInt((cpus || "").trim(), 10) || 1,
        exitCode: Number.isFinite(exitRc) ? exitRc : 0,
        gpus: 0, // filled in below from scontrol's JOB_GRES line
      };
    })
    .filter((r) => Number.isFinite(r.slurmJobId) && r.slurmJobId > 0)
    .filter((r) => {
      // Drop rows submitted before this cluster row existed — they came
      // from a previous cluster instance on the same backing slurm DB.
      // See the long comment above the `rows` map for the full rationale.
      if (!r.submit) return true;  // malformed timestamp → let it through
      const submittedAt = new Date(r.submit);
      if (Number.isNaN(submittedAt.getTime())) return true;
      if (submittedAt < clusterCreatedAt) {
        preCreatedSkipped++;
        return false;
      }
      return true;
    });

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
    select: { id: true, slurmJobId: true, script: true, status: true, exitCode: true },
  });
  const existing = new Map(existingRows.map((e) => [e.slurmJobId!, e]));

  const unixNames = Array.from(new Set(rows.map((r) => r.user).filter(Boolean)));
  const users = await prisma.user.findMany({
    where: { unixUsername: { in: unixNames } },
    select: { id: true, unixUsername: true },
  });
  const userByUnix = new Map(users.map((u) => [u.unixUsername!, u.id]));

  // For unix usernames that exist on the cluster (Linux + Slurm) but have
  // no matching Aura User row, auto-create a placeholder USER-role row
  // and link them as a ClusterUser. Otherwise sacct rows for those users
  // get skipped on every import — and the admin has to go through the
  // Users tab and click Adopt for each one before re-importing, which
  // becomes painful on shared backing containers where multiple Aura
  // instances have submitted jobs as the same Linux account. The
  // placeholder is clearly marked (`imported:slurm:<user>` keycloakId,
  // `<user>+imported@<clusterId-short>.aura.local` email) so an admin
  // can find and merge it with a real user later.
  const missing = unixNames.filter((u) => !userByUnix.has(u));
  let adopted = 0;
  if (missing.length > 0) {
    // Probe the cluster for the uid/gid of each missing user. Done in a
    // single SSH round-trip so an N-user backlog doesn't fan out into N
    // session establishments. Fall back to null uid if getent doesn't
    // know the user (the User row still gets created — slurm history is
    // attributable even when the Linux account no longer exists).
    const getentScript = missing.map((u) => `getent passwd "${u.replace(/[^A-Za-z0-9._-]/g, "")}" || echo "${u}: notfound"`).join("\n");
    const getentRes = await sshExecSimple(
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
      getentScript,
    );
    const uidByName = new Map<string, { uid: number; gid: number } | null>();
    if (getentRes.success) {
      for (const line of getentRes.stdout.split("\n")) {
        // Expected formats: "user:x:UID:GID:gecos:home:shell" or "user: notfound"
        const m = line.match(/^([A-Za-z0-9._-]+):x:(\d+):(\d+):/);
        if (m) uidByName.set(m[1], { uid: parseInt(m[2], 10), gid: parseInt(m[3], 10) });
        else {
          const nf = line.match(/^([A-Za-z0-9._-]+):\s*notfound$/);
          if (nf) uidByName.set(nf[1], null);
        }
      }
    }

    const shortCid = id.slice(0, 8);
    for (const uname of missing) {
      const idents = uidByName.get(uname) ?? null;
      try {
        // Use upsert keyed on unixUsername so a concurrent import (or an
        // earlier Adopt action) doesn't duplicate. The `update` body is
        // intentionally empty — once the User exists we don't overwrite
        // fields a human might have edited.
        const created = await prisma.user.upsert({
          where: { unixUsername: uname },
          update: {},
          create: {
            keycloakId: `imported:slurm:${uname}`,
            email: `${uname}+imported.${shortCid}@aura.local`,
            name: uname,
            unixUsername: uname,
            unixUid: idents?.uid,
            unixGid: idents?.gid,
            role: "VIEWER",
          },
          select: { id: true, unixUsername: true },
        });
        userByUnix.set(uname, created.id);
        // Best-effort cluster-user link so the user shows up in the
        // cluster's Users tab as ACTIVE (matches what Adopt would have
        // done). Ignore unique-key races.
        await prisma.clusterUser.upsert({
          where: { userId_clusterId: { userId: created.id, clusterId: id } },
          update: { status: "ACTIVE", provisionedAt: new Date() },
          create: {
            userId: created.id,
            clusterId: id,
            status: "ACTIVE",
            provisionedAt: new Date(),
          },
        }).catch(() => {});
        adopted++;
      } catch (e) {
        // unixUsername unique-collision (race) or other constraint —
        // refresh the lookup map from DB so subsequent rows can still
        // import under the user another concurrent request created.
        const existing = await prisma.user.findUnique({ where: { unixUsername: uname }, select: { id: true } });
        if (existing) userByUnix.set(uname, existing.id);
        // Else fall through; the row stays orphan-listed.
      }
    }
  }

  let imported = 0;
  let skippedExisting = 0;
  let skippedNoUser = 0;
  let statusUpdated = 0;
  const orphans: Array<{ slurmJobId: number; user: string }> = [];

  let backfilled = 0;
  for (const r of rows) {
    const existingJob = existing.get(r.slurmJobId);
    if (existingJob) {
      // Status reconciliation: the whole point of the sacct-backed sync.
      // If Slurm's accounting now reports a different state than our DB
      // (typically the job was cancelled/finished outside this UI), flip
      // the row in-place. Without this, an out-of-band cancel would
      // leave a stale RUNNING row forever — the original symptom that
      // motivated this change.
      const liveStatus = mapState(r.state);
      const updates: Record<string, unknown> = {};
      if (liveStatus !== existingJob.status) {
        updates.status = liveStatus;
        // Capture the sacct exit code on terminal transitions so the UI
        // can show it. Don't overwrite with 0 if the existing row already
        // has a non-zero one cached by the watcher (less precise field).
        const terminal = liveStatus === "COMPLETED" || liveStatus === "FAILED" || liveStatus === "CANCELLED";
        if (terminal && r.exitCode !== existingJob.exitCode) {
          updates.exitCode = r.exitCode;
        }
        statusUpdated++;
      }

      // Backfill: if the stored script is missing GPU/CPU directives but
      // sacct has them, update in place. No-op once it has been done.
      // Saves the user from re-importing everything.
      const lacksCpu = !/^#SBATCH\s+(?:--cpus-per-task|-c)[=\s]/m.test(existingJob.script);
      const lacksGpu = !/^#SBATCH\s+--gres=gpu/m.test(existingJob.script);
      const hasCpuToAdd = lacksCpu && r.cpus > 1;
      const hasGpuToAdd = lacksGpu && r.gpus > 0;
      if (hasCpuToAdd || hasGpuToAdd) {
        const additions: string[] = [];
        if (hasCpuToAdd) additions.push(`#SBATCH --cpus-per-task=${r.cpus}`);
        if (hasGpuToAdd) additions.push(`#SBATCH --gres=gpu:${r.gpus}`);
        updates.script = `${existingJob.script.replace(/\n+$/, "")}\n${additions.join("\n")}\n`;
        backfilled++;
      }

      if (Object.keys(updates).length > 0) {
        await prisma.job.update({
          where: { id: existingJob.id },
          data: updates,
        }).catch(() => {});
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
    metadata: { imported, adopted, skippedExisting, skippedNoUser, statusUpdated, backfilled, preCreatedSkipped, total: rows.length },
  });

  return NextResponse.json({
    total: rows.length,
    imported,
    // Number of placeholder Aura User rows auto-created during this run
    // (one per unmatched unixUsername). 0 on steady-state imports where
    // every job's user already has an Aura row.
    adopted,
    skippedExisting,
    skippedNoUser,
    statusUpdated,
    backfilled,
    // sacct rows whose Submit timestamp is before cluster.createdAt —
    // typical when a fresh Aura cluster row reuses a backing slurm
    // controller that's been used by a previous Aura cluster (the
    // mariadb accounting DB persists across slurmctld restarts).
    preCreatedSkipped,
    orphans: orphans.slice(0, 20),
  });
}
