/**
 * Probe whether <jobNode>:<port>/metrics is actually serving Prometheus
 * metrics for this Job. Used by the "Expose metrics" tab to refuse to
 * persist a port the cluster can't actually scrape.
 *
 * Sources:
 *   - RUNNING job: pick the first hostname out of squeue %N, ssh into the
 *     controller and curl http://<host>:<port>/metrics. 200 + Prom-style
 *     body = ok.
 *   - PENDING / not-yet-scheduled: return ok=true with skipped=true so the
 *     UI can still let the user save (Prometheus retries until the target
 *     comes up).
 *   - FINISHED / no NodeList: ok=false with a reason.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple, getClusterSshTarget } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string; jobId: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const port = Number(body.port);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    return NextResponse.json({ error: "port must be 1-65535" }, { status: 400 });
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.clusterId !== id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if ((session.user as any).role !== "ADMIN" && job.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (job.status === "PENDING") {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "Job is still PENDING — can't probe yet. Prometheus will retry once it starts; saving anyway.",
    });
  }
  if (job.status !== "RUNNING") {
    return NextResponse.json({
      ok: false,
      reason: `Job state is ${job.status}; nothing is listening on :${port}/metrics.`,
    }, { status: 400 });
  }
  if (!job.slurmJobId) {
    return NextResponse.json({ ok: false, reason: "Job has no Slurm id yet." }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id }, include: { sshKey: true } });
  if (!cluster || !cluster.sshKey || cluster.connectionMode !== "SSH") {
    return NextResponse.json({ ok: false, reason: "Cluster is not in SSH mode." }, { status: 412 });
  }
  const target = await getClusterSshTarget(id);
  if (!target) return NextResponse.json({ ok: false, reason: "No SSH target." }, { status: 412 });
  const tgt = { ...target, bastion: cluster.sshBastion };

  // Pick the first node the job runs on, then curl <host>:<port>/metrics
  // from the controller. Probe every running host one after another so we
  // catch "running on N1+N2 but only N1 is serving" partial-rollouts.
  const cmd = `RAW=$(squeue -h -j "${job.slurmJobId}" -o "%N" 2>/dev/null)
if [ -z "$RAW" ] || [ "$RAW" = "(null)" ]; then
  echo "__NO_NODES__"
  exit 0
fi
HOSTS=$(scontrol show hostnames "$RAW" 2>/dev/null)
for H in $HOSTS; do
  CODE=$(curl -s -o /tmp/_aura_probe -w '%{http_code}' --max-time 4 "http://$H:${port}/metrics" 2>/dev/null || echo "000")
  HEAD=$(head -c 200 /tmp/_aura_probe 2>/dev/null | tr '\\n' ' ')
  rm -f /tmp/_aura_probe
  echo "__HOST__=$H code=$CODE head=$HEAD"
done`;
  const r = await sshExecSimple(tgt, cmd);
  if (!r.success) {
    return NextResponse.json({ ok: false, reason: r.stderr || "SSH probe failed", detail: r.stdout.slice(-400) }, { status: 502 });
  }
  if (r.stdout.includes("__NO_NODES__")) {
    return NextResponse.json({ ok: false, reason: "Job is RUNNING but Slurm has no nodelist for it yet." });
  }

  type Probe = { host: string; code: string; head: string };
  const probes: Probe[] = [];
  for (const raw of r.stdout.split("\n")) {
    const m = raw.match(/^__HOST__=(\S+) code=(\d{3}) head=(.*)$/);
    if (!m) continue;
    probes.push({ host: m[1], code: m[2], head: m[3].trim() });
  }
  if (probes.length === 0) {
    return NextResponse.json({ ok: false, reason: "No host probes returned. Is squeue happy with this job id?" });
  }

  const ok = probes.find((p) => p.code === "200");
  const looksPrometheus = (head: string) =>
    head.startsWith("# HELP") || head.startsWith("# TYPE") || /^[a-zA-Z_:][a-zA-Z0-9_:]*[ {]/.test(head);

  if (ok) {
    if (!looksPrometheus(ok.head)) {
      // 200 but body doesn't look like Prom — maybe the port is serving
      // an HTML page or unrelated API. Warn but allow.
      return NextResponse.json({
        ok: true,
        warning: `Got HTTP 200 from ${ok.host}:${port}/metrics but the body doesn't look like Prometheus exposition format. Saving anyway, but Prometheus might fail to parse.`,
        host: ok.host,
        sampleHead: ok.head.slice(0, 200),
      });
    }
    return NextResponse.json({ ok: true, host: ok.host, code: ok.code });
  }

  // None of the hosts answered 200. Build a useful error.
  const summary = probes.map((p) => `${p.host}:${port} → HTTP ${p.code === "000" ? "no response" : p.code}`).join("; ");
  return NextResponse.json({
    ok: false,
    reason: `No host answered :${port}/metrics. ${summary}. Make sure the job is actually listening on this port (e.g. \`vllm serve --port ${port}\`) and the firewall allows it from the cluster's Prometheus host.`,
    probes,
  });
}
