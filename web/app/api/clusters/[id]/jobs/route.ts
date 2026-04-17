import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sendCommandAndWait, publishCommand } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";
import { startJobWatcher } from "@/lib/job-watcher";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/clusters/[id]/jobs — list jobs from DB
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") ?? "1");
  const limit = parseInt(url.searchParams.get("limit") ?? "20");
  const skip = (page - 1) * limit;
  const nameFilter = (url.searchParams.get("name") ?? "").trim();
  const statusFilter = (url.searchParams.get("status") ?? "").trim();
  const partitionFilter = (url.searchParams.get("partition") ?? "").trim();
  const fromFilter = (url.searchParams.get("from") ?? "").trim();
  const toFilter = (url.searchParams.get("to") ?? "").trim();

  const where: Record<string, unknown> = { clusterId: id };
  if ((session.user as any).role !== "ADMIN") {
    where.userId = session.user.id;
  }
  if (statusFilter) where.status = statusFilter;
  if (partitionFilter) where.partition = partitionFilter;
  if (nameFilter) {
    // job-name lives inside the stored SBATCH script.
    where.script = { contains: nameFilter, mode: "insensitive" };
  }
  if (fromFilter || toFilter) {
    const range: Record<string, Date> = {};
    if (fromFilter) {
      const d = new Date(fromFilter);
      if (!isNaN(d.getTime())) range.gte = d;
    }
    if (toFilter) {
      const d = new Date(toFilter);
      if (!isNaN(d.getTime())) {
        // "to" is inclusive for the whole day the user picked.
        d.setHours(23, 59, 59, 999);
        range.lte = d;
      }
    }
    if (Object.keys(range).length > 0) where.createdAt = range;
  }

  const [jobs, total, partitionsRaw, clusterRow] = await Promise.all([
    prisma.job.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit }),
    prisma.job.count({ where }),
    prisma.job.findMany({
      where: { clusterId: id, ...(((session.user as any).role !== "ADMIN") ? { userId: session.user.id } : {}) },
      distinct: ["partition"],
      select: { partition: true },
    }),
    prisma.cluster.findUnique({ where: { id }, select: { config: true } }),
  ]);

  // Derive job name from the stored SBATCH script so we can show a Name column.
  const nameRe = /#SBATCH\s+(?:--job-name|-J)[=\s]+(\S+)/;
  const withName = jobs.map((j) => {
    const m = j.script?.match(nameRe);
    return { ...j, name: m ? m[1] : null };
  });

  // Available partitions for the filter dropdown: union of (cluster-config
  // partitions) + (distinct partitions used by any past job).
  const cfg = (clusterRow?.config ?? {}) as Record<string, unknown>;
  const configPartitions = (cfg.slurm_partitions as Array<{ name: string }> | undefined)?.map((p) => p.name) ?? [];
  const availablePartitions = Array.from(new Set([
    ...configPartitions,
    ...partitionsRaw.map((p) => p.partition),
  ])).filter(Boolean).sort();

  return NextResponse.json({
    jobs: withName,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    partitions: availablePartitions,
  });
}

// POST /api/clusters/[id]/jobs — submit a Slurm job
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  if (cluster.status !== "ACTIVE" && cluster.status !== "DEGRADED") {
    return NextResponse.json({ error: "Cluster is not accepting jobs" }, { status: 503 });
  }

  // Verify the submitting user is provisioned and ACTIVE on this cluster.
  const dbUser = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // All users (including admins) must be actively provisioned to submit jobs.
  const clusterUser = await prisma.clusterUser.findUnique({
    where: { userId_clusterId: { userId: session.user.id, clusterId: id } },
  });
  if (!clusterUser || clusterUser.status !== "ACTIVE") {
    return NextResponse.json(
      { error: "You must be provisioned on this cluster before submitting jobs." },
      { status: 403 }
    );
  }

  const body = await req.json();
  const { script, partition } = body;

  if (!script || !partition) {
    return NextResponse.json({ error: "Missing required fields: script, partition" }, { status: 400 });
  }

  // Create job record first so we have an ID for tracking
  const job = await prisma.job.create({
    data: { clusterId: id, userId: session.user.id, script, partition, status: "PENDING" },
  });

  try {
    const config = cluster.config as Record<string, unknown>;
    const username = dbUser.unixUsername ?? "";
    const dataNfsPath = (config.data_nfs_path as string | undefined) ?? "";
    const workDir = username && dataNfsPath ? `${dataNfsPath}/${username}` : "";

    // SSH mode: run sbatch directly on the controller via SSH.
    if (cluster.connectionMode === "SSH") {
      const clusterWithKey = await prisma.cluster.findUnique({
        where: { id },
        include: { sshKey: true },
      });
      if (!clusterWithKey?.sshKey) {
        throw new Error("Cluster has no SSH key assigned");
      }

      const target = {
        host: cluster.controllerHost,
        user: cluster.sshUser,
        port: cluster.sshPort,
        privateKey: clusterWithKey.sshKey.privateKey,
        bastion: cluster.sshBastion,
      };

      if (!username) {
        throw new Error("Cannot submit — your user has not been provisioned with a Linux account.");
      }
      const submitDir = workDir || `/tmp`;
      const scriptName = `.aura-job-${job.id.slice(0, 8)}.sh`;
      const scriptPath = `${submitDir}/${scriptName}`;
      const scriptB64 = Buffer.from(script).toString("base64");

      const wrapper = `#!/bin/bash
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"

# Ensure submission dir exists and is writable by the user
$S mkdir -p ${submitDir}
$S chown ${username}:${username} ${submitDir} 2>/dev/null || true

# Write the user's script (base64-decoded to preserve quoting)
echo "${scriptB64}" | base64 -d | $S tee ${scriptPath} > /dev/null
$S chown ${username}:${username} ${scriptPath}
$S chmod 755 ${scriptPath}

# Submit as the target user. --parsable prints "<jobid>[;cluster]" to stdout.
OUT=$(sudo -u ${username} -H bash -c "cd ${submitDir} && sbatch --parsable ${scriptPath}" 2>&1)
RC=$?
echo "__AURA_SBATCH_EXIT__=$RC"
echo "__AURA_SBATCH_OUT__=$OUT"
exit $RC
`;

      const stdoutLines: string[] = [];
      const success = await new Promise<boolean>((resolve) => {
        sshExecScript(target, wrapper, {
          onStream: (line) => stdoutLines.push(line),
          onComplete: (ok) => resolve(ok),
        });
      });

      const full = stdoutLines.join("\n");
      const outMatch = full.match(/__AURA_SBATCH_OUT__=([\s\S]*?)(?:\n__|$)/);
      const sbatchOut = outMatch ? outMatch[1].trim() : full;

      if (!success) {
        throw new Error(sbatchOut || "sbatch failed");
      }

      const idMatch = sbatchOut.match(/(\d+)/);
      if (!idMatch) {
        throw new Error(sbatchOut || "Could not parse Slurm job ID");
      }
      const slurmJobId = parseInt(idMatch[1], 10);

      const updated = await prisma.job.update({
        where: { id: job.id },
        data: { slurmJobId, status: "RUNNING" },
      });

      // Detached watcher — survives tab close. Writes output + final status
      // to the DB; the SSE stream polls the DB rather than tailing directly.
      startJobWatcher(clusterWithKey as any, updated as any);

      await logAudit({
        action: "job.submit",
        entity: "Job",
        entityId: job.id,
        metadata: { clusterId: id, clusterName: cluster.name, partition, slurmJobId, mode: "ssh" },
      });

      return NextResponse.json(updated, { status: 201 });
    }

    const result = await sendCommandAndWait(
      id,
      {
        request_id: job.id,
        type: "submit_job",
        payload: {
          script,
          partition,
          job_name: `aura-${job.id.slice(0, 8)}`,
          work_dir: workDir,
          username,
        },
      },
      60_000 // sbatch is fast
    ) as { slurm_job_id?: number; output_file?: string };

    const updated = await prisma.job.update({
      where: { id: job.id },
      data: { slurmJobId: result.slurm_job_id ?? null, status: "RUNNING" },
    });

    // Fire-and-forget: stream the job output file via the same request ID.
    // The WS subscriber on the job page will pick up the streamed lines.
    if (result.slurm_job_id && result.output_file) {
      publishCommand(id, {
        request_id: job.id,
        type: "watch_job",
        payload: {
          slurm_job_id: result.slurm_job_id,
          output_file: result.output_file,
        },
      }).catch((err) => console.error("[jobs] Failed to dispatch watch_job:", err));
    } else if (result.slurm_job_id) {
      // No output file (e.g. admin job with no workDir) — mark completed immediately.
      // We can't stream output but the job was submitted successfully.
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "COMPLETED", exitCode: 0 },
      }).catch(() => {});
    }

    await logAudit({
      action: "job.submit",
      entity: "Job",
      entityId: job.id,
      metadata: { clusterId: id, clusterName: cluster.name, partition, slurmJobId: result.slurm_job_id },
    });

    return NextResponse.json(updated, { status: 201 });
  } catch (err) {
    await prisma.job.update({ where: { id: job.id }, data: { status: "FAILED" } });

    await logAudit({
      action: "job.submit_failed",
      entity: "Job",
      entityId: job.id,
      metadata: { clusterId: id, clusterName: cluster.name, partition, error: err instanceof Error ? err.message : "Unknown" },
    });

    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Job submission failed: ${message}`, job }, { status: 502 });
  }
}
