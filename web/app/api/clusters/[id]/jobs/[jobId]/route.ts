import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sendCommandAndWait } from "@/lib/nats";
import { sshExecScript } from "@/lib/ssh-exec";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string; jobId: string }>;
}

// GET /api/clusters/[id]/jobs/[jobId] — job detail
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const job = await prisma.job.findFirst({
    where: {
      id: jobId,
      clusterId: id,
      ...((session.user as any).role !== "ADMIN" ? { userId: session.user.id } : {}),
    },
    include: {
      cluster: {
        select: { name: true, status: true },
      },
    },
  });

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Job has no Prisma relation back to User (kept out of the schema to avoid
  // cascading migration churn), so fetch it separately and splice into the
  // response so the detail page can show who submitted.
  const user = await prisma.user.findUnique({
    where: { id: job.userId },
    select: { email: true, name: true, unixUsername: true },
  });

  // If job is running, optionally fetch latest status from agent
  if (job.status === "RUNNING" && job.slurmJobId && job.cluster.status !== "OFFLINE") {
    try {
      const result = await sendCommandAndWait(id, {
        request_id: randomUUID(),
        type: "job_info",
        payload: { job_id: String(job.slurmJobId) },
      }, 10000) as { state?: string; exit_code?: number };

      // Update local status if changed
      if (result.state) {
        const statusMap: Record<string, string> = {
          COMPLETED: "COMPLETED",
          FAILED: "FAILED",
          CANCELLED: "CANCELLED",
          RUNNING: "RUNNING",
          PENDING: "PENDING",
        };
        const newStatus = statusMap[result.state] ?? job.status;
        if (newStatus !== job.status) {
          await prisma.job.update({
            where: { id: jobId },
            data: {
              status: newStatus as any,
              exitCode: result.exit_code ?? null,
            },
          });
          job.status = newStatus as any;
          job.exitCode = result.exit_code ?? null;
        }
      }
    } catch {
      // Agent unreachable — return cached data
    }
  }

  return NextResponse.json({ ...job, user });
}

// DELETE /api/clusters/[id]/jobs/[jobId] — cancel job
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const job = await prisma.job.findFirst({
    where: {
      id: jobId,
      clusterId: id,
      ...((session.user as any).role !== "ADMIN" ? { userId: session.user.id } : {}),
    },
  });

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.status !== "RUNNING" && job.status !== "PENDING") {
    return NextResponse.json(
      { error: "Job is not running or pending" },
      { status: 400 }
    );
  }

  // Actually kill the Slurm job. In SSH mode the NATS path below is a
  // no-op (no agent), so we were just flipping the DB row to CANCELLED
  // while the job kept running in the queue. Run scancel directly over
  // SSH, matching what the gitops reconciler does.
  if (job.slurmJobId) {
    const cluster = await prisma.cluster.findUnique({
      where: { id },
      include: { sshKey: true },
    });

    if (cluster?.connectionMode === "SSH" && cluster.sshKey) {
      const target = {
        host: cluster.controllerHost,
        user: cluster.sshUser,
        port: cluster.sshPort,
        privateKey: cluster.sshKey.privateKey,
        bastion: cluster.sshBastion,
      };
      // --signal=KILL + --full sends SIGKILL to every step (sbatch wrapper
      // + the user's batch shell) without waiting for KillWait. Try as the
      // ssh user first; fall back to sudo -n so root can cancel any job.
      const script = `#!/bin/bash
set +e
trap 'ec=$?; echo "[trace] bash exiting (status=$ec) at line $LINENO"' EXIT
OUT=$(scancel --signal=KILL --full ${job.slurmJobId} 2>&1)
RC=$?
echo "$OUT"
if [ $RC -eq 0 ]; then
  echo "[scancel-ok] job ${job.slurmJobId} cancelled by $(id -un)"
  exit 0
fi
echo "[scancel-retry] retrying with sudo -n"
sudo -n scancel --signal=KILL --full ${job.slurmJobId} 2>&1
SUDO_RC=$?
if [ $SUDO_RC -eq 0 ]; then
  echo "[scancel-ok] job ${job.slurmJobId} cancelled via sudo"
  exit 0
fi
echo "[scancel-fail] scancel rc=$RC sudo rc=$SUDO_RC"
exit 1
`;
      await new Promise<void>((resolve) => {
        sshExecScript(target, script, {
          onStream: () => {},
          onComplete: () => resolve(),
        });
      });
    } else {
      // NATS mode
      try {
        await sendCommandAndWait(id, {
          request_id: randomUUID(),
          type: "cancel_job",
          payload: { job_id: String(job.slurmJobId) },
        }, 15000);
      } catch {
        // Best effort — still mark as cancelled locally
      }
    }
  }

  const updatedJob = await prisma.job.update({
    where: { id: jobId },
    data: { status: "CANCELLED" },
  });

  await logAudit({
    action: "job.cancel",
    entity: "Job",
    entityId: jobId,
    metadata: { clusterId: id, slurmJobId: job.slurmJobId },
  });

  return NextResponse.json(updatedJob);
}

// PATCH /api/clusters/[id]/jobs/[jobId] — partial update. Currently scoped
// to the metricsPort field (Prometheus scrape opt-in). Only the job's owner
// or an admin can flip it. Triggers a side-effect rebuild of the cluster's
// Prometheus file_sd targets (best-effort) so the change shows up without
// the user clicking Refresh.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.clusterId !== id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if ((session.user as any).role !== "ADMIN" && job.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const data: {
    metricsPort?: number | null;
    proxyPort?: number | null;
    proxyName?: string | null;
    proxyPublic?: boolean;
  } = {};
  if ("metricsPort" in body) {
    if (body.metricsPort === null || body.metricsPort === "" || body.metricsPort === undefined) {
      data.metricsPort = null;
    } else {
      const n = Number(body.metricsPort);
      if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
        return NextResponse.json({ error: "metricsPort must be a TCP port (1-65535)" }, { status: 400 });
      }
      data.metricsPort = n;
    }
  }
  if ("proxyPort" in body) {
    if (body.proxyPort === null || body.proxyPort === "" || body.proxyPort === undefined) {
      data.proxyPort = null;
      data.proxyName = null;
    } else {
      const n = Number(body.proxyPort);
      if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
        return NextResponse.json({ error: "proxyPort must be a TCP port (1-65535)" }, { status: 400 });
      }
      data.proxyPort = n;
    }
  }
  if ("proxyName" in body) {
    if (body.proxyName === null || body.proxyName === "" || body.proxyName === undefined) {
      data.proxyName = null;
    } else if (typeof body.proxyName === "string") {
      const s = body.proxyName.trim().slice(0, 64);
      data.proxyName = s.length > 0 ? s : null;
    }
  }
  if ("proxyPublic" in body) {
    data.proxyPublic = body.proxyPublic === true;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no supported fields in body" }, { status: 400 });
  }

  let updated;
  try {
    updated = await prisma.job.update({ where: { id: jobId }, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Most likely culprit when the schema's been bumped but the running
    // pod's DB hasn't: prisma reports the new column as unknown. Surface
    // a useful hint instead of a stock 500.
    const looksLikeMissingColumn =
      /column .* does not exist|unknown.*field|Unknown argument/i.test(msg) ||
      /metricsPort|proxyPort|proxyName/i.test(msg);
    return NextResponse.json(
      {
        error: looksLikeMissingColumn
          ? "Database is missing one of the metricsPort / proxyPort columns — run `npx prisma db push` (or restart the web container, which does it on boot)."
          : "Job update failed",
        detail: msg.slice(0, 1500),
      },
      { status: 500 },
    );
  }

  await logAudit({
    action: "metricsPort" in data ? "job.metrics_port.update" : "job.proxy_port.update",
    entity: "Job",
    entityId: jobId,
    metadata: {
      clusterId: id,
      slurmJobId: job.slurmJobId,
      ...("metricsPort" in data ? { metricsPort: data.metricsPort ?? null } : {}),
      ...("proxyPort" in data ? { proxyPort: data.proxyPort ?? null, proxyName: data.proxyName ?? null } : {}),
    },
  });

  // Best-effort target refresh — fire and forget, only when metricsPort
  // actually changed (proxyPort doesn't touch Prometheus).
  if ("metricsPort" in data) {
    (async () => {
      try {
        const proto = req.headers.get("x-forwarded-proto") ?? "http";
        const host = req.headers.get("host") ?? "localhost";
        await fetch(`${proto}://${host}/api/clusters/${id}/metrics/refresh-targets`, {
          method: "POST",
          headers: { cookie: req.headers.get("cookie") ?? "" },
        });
      } catch {}
    })();
  }

  return NextResponse.json(updated);
}
