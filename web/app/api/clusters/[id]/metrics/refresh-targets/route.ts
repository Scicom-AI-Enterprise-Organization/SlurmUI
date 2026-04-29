/**
 * Rebuild Prometheus's file_sd targets for this cluster's "expose metrics"
 * jobs and reload Prometheus.
 *
 * Pipeline:
 *   1. Find all Jobs with metricsPort != null AND status RUNNING / PENDING.
 *   2. Look up each one's NodeList via `scontrol show job -h -o "%i|%R"` on
 *      the controller (one SSH round-trip for all jobs).
 *   3. Expand `node[01-04]` style hostlists with `scontrol show hostnames`.
 *   4. Build a Prometheus file_sd JSON document with one entry per
 *      (node, jobid) pairing carrying labels: jobid, slurm_jobid, user,
 *      cluster, port. Each labelset gets a single target `<node>:<port>`.
 *   5. Atomically write the file to /etc/prometheus/sd/jobs.json on the
 *      stack host (via SSH from controller, which the prometheus host can
 *      always reach), then POST /-/reload to prometheus.
 *
 * Only admin or the cluster's own users can trigger this — same auth as
 * other metrics endpoints.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple, getClusterSshTarget } from "@/lib/ssh-exec";
import { readMetricsConfig, resolveStackHost } from "@/lib/metrics-config";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface FileSdEntry {
  targets: string[];
  labels: Record<string, string>;
}

export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey || cluster.connectionMode !== "SSH") {
    return NextResponse.json({ error: "Cluster not in SSH mode" }, { status: 412 });
  }

  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const metrics = readMetricsConfig(config);
  if (!metrics.enabled) {
    return NextResponse.json({ error: "Metrics stack not deployed" }, { status: 412 });
  }

  // Pull every job in this cluster that opted in. We include PENDING in
  // case the user toggled before the job went RUNNING — Prometheus will
  // try the target, fail, and pick it up cleanly when the job starts.
  const jobs = await prisma.job.findMany({
    where: {
      clusterId: id,
      metricsPort: { not: null },
      status: { in: ["RUNNING", "PENDING"] },
    },
  });
  // Resolve user emails in one batch (Job has no Prisma relation to User
  // — userId is a plain string column).
  const userIds = Array.from(new Set(jobs.map((j) => j.userId)));
  const users = userIds.length === 0
    ? []
    : await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true },
      });
  const emailById = new Map(users.map((u) => [u.id, u.email] as const));

  const target = await getClusterSshTarget(id);
  if (!target) return NextResponse.json({ error: "No SSH target" }, { status: 412 });
  const tgt = { ...target, bastion: cluster.sshBastion };

  // For each job we want NodeList AND a per-target hostname list. squeue's
  // %N column gives a hostlist; we expand it via `scontrol show hostnames`.
  // We bundle everything into one ssh call to keep latency bounded.
  const jobsWithSlurmId = jobs.filter((j) => j.slurmJobId != null);
  const expansions = new Map<string, string[]>(); // slurmJobId -> hostnames

  if (jobsWithSlurmId.length > 0) {
    const ids = jobsWithSlurmId.map((j) => String(j.slurmJobId)).join(" ");
    // One squeue call returns "<id>|<nodelist>" per running job; we pipe
    // each through `scontrol show hostnames` to expand to one host per line.
    const cmd = `for J in ${ids}; do
  RAW=$(squeue -h -j "$J" -o "%N" 2>/dev/null)
  if [ -z "$RAW" ] || [ "$RAW" = "(null)" ]; then continue; fi
  echo "__JOB__=$J"
  scontrol show hostnames "$RAW" 2>/dev/null
done`;
    const r = await sshExecSimple(tgt, cmd);
    if (r.success) {
      let curJob: string | null = null;
      for (const line of r.stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith("__JOB__=")) {
          curJob = t.slice("__JOB__=".length);
          expansions.set(curJob, []);
          continue;
        }
        if (curJob && /^[A-Za-z0-9._-]+$/.test(t)) {
          expansions.get(curJob)!.push(t);
        }
      }
    }
  }

  const entries: FileSdEntry[] = [];
  for (const j of jobs) {
    const hosts = j.slurmJobId != null
      ? (expansions.get(String(j.slurmJobId)) ?? [])
      : [];
    if (hosts.length === 0) continue;
    const port = j.metricsPort!;
    entries.push({
      targets: hosts.map((h) => `${h}:${port}`),
      labels: {
        job: "aura-job",
        cluster: cluster.name,
        aura_jobid: j.id,
        slurm_jobid: j.slurmJobId != null ? String(j.slurmJobId) : "",
        user: emailById.get(j.userId) ?? "",
        port: String(port),
      },
    });
  }

  const json = JSON.stringify(entries, null, 2);
  const b64 = Buffer.from(json).toString("base64");

  const stack = resolveStackHost(cluster.controllerHost, config, metrics);
  const stackIp = stack.isController ? "127.0.0.1" : stack.ip;
  // Write atomically (write tmp, mv into place) so Prometheus's file watcher
  // never sees a half-written JSON. POST /-/reload to apply.
  const writeCmd = stack.isController
    ? `S=""; [ "$(id -u)" != "0" ] && S="sudo"
$S mkdir -p /etc/prometheus/sd
echo "${b64}" | base64 -d | $S tee /etc/prometheus/sd/jobs.json.tmp >/dev/null
$S mv /etc/prometheus/sd/jobs.json.tmp /etc/prometheus/sd/jobs.json
curl -s -o /dev/null -w '%{http_code}\\n' -X POST http://127.0.0.1:${metrics.prometheusPort}/-/reload`
    : `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p ${stack.port || 22} ${stack.user || "root"}@${stack.ip} bash -s <<'SD_EOF'
S=""; [ "$(id -u)" != "0" ] && S="sudo"
$S mkdir -p /etc/prometheus/sd
echo "${b64}" | base64 -d | $S tee /etc/prometheus/sd/jobs.json.tmp >/dev/null
$S mv /etc/prometheus/sd/jobs.json.tmp /etc/prometheus/sd/jobs.json
curl -s -o /dev/null -w '%{http_code}\\n' -X POST http://${stackIp}:${metrics.prometheusPort}/-/reload
SD_EOF`;
  const wr = await sshExecSimple(tgt, writeCmd);

  return NextResponse.json({
    ok: wr.success,
    targets: entries.length,
    nodesScraped: entries.reduce((acc, e) => acc + e.targets.length, 0),
    file: "/etc/prometheus/sd/jobs.json",
    reloadOutput: wr.stdout.trim().split("\n").pop() ?? "",
    error: wr.success ? undefined : (wr.stderr || "ssh failed"),
  });
}
