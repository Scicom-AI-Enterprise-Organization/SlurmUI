/**
 * Fetch service logs from a cluster — programmatic / CLI use.
 *
 * Branches on cluster.config.node_supervisor (set by the heartbeat probe
 * the first time it sees the controller). On systemd hosts we run
 * `journalctl -u <service>`; on pm2-go hosts we tail the per-service
 * out/err files under /root/.pm2-go/logs/.
 *
 *   curl -H "Authorization: Bearer aura_…" \
 *     "http://localhost:3000/api/v1/clusters/<id>/logs?service=slurmctld&lines=200"
 *
 * Query params:
 *   service (required) — slurmctld | slurmdbd | slurmd | munge | mariadb |
 *                        chrony | sssd | nfs-kernel-server | anything else
 *                        the cluster registered.
 *   lines   (optional) — default 200, clamped to [10, 5000].
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple, getClusterSshTarget } from "@/lib/ssh-exec";
import { getSupervisor, logsCmd } from "@/lib/supervisor";

interface RouteParams { params: Promise<{ cluster: string }> }

// Allowlist — anything not in here is rejected so we don't shell-out a
// user-controlled service name. Add services here as new components land.
const ALLOWED_SERVICES = new Set([
  "slurmctld",
  "slurmdbd",
  "slurmd",
  "munge",
  "mariadb",
  "mysql",
  "chrony",
  "sssd",
  "nfs-kernel-server",
]);

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { cluster: id } = await params;

  const user = await getApiUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const service = (url.searchParams.get("service") ?? "").trim();
  if (!ALLOWED_SERVICES.has(service)) {
    return NextResponse.json({
      error: `service must be one of: ${[...ALLOWED_SERVICES].join(", ")}`,
    }, { status: 400 });
  }
  const linesRaw = Number(url.searchParams.get("lines") ?? "200");
  const lines = Number.isFinite(linesRaw)
    ? Math.max(10, Math.min(5000, Math.floor(linesRaw)))
    : 200;

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const target = await getClusterSshTarget(id);
  if (!target) return NextResponse.json({ error: "No SSH target" }, { status: 412 });
  const tgt = { ...target, bastion: cluster.sshBastion };

  const supervisor = getSupervisor(cluster);
  // journalctl needs root for full visibility; pm2-go log files are
  // owned by whoever ran startOrReload (root in our bootstrap).
  const cmd = `S=""; [ "$(id -u)" != "0" ] && S="sudo"; $S ${logsCmd(supervisor, service, lines)} 2>&1 || true`;

  const start = Date.now();
  const r = await sshExecSimple(tgt, cmd);
  const durationMs = Date.now() - start;

  return NextResponse.json({
    clusterId: id,
    clusterName: cluster.name,
    service,
    supervisor,
    lines,
    durationMs,
    success: r.success,
    output: r.stdout,
    stderr: r.stderr,
  }, { status: r.success ? 200 : 500 });
}
