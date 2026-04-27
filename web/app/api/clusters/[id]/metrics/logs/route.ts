import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple, getClusterSshTarget } from "@/lib/ssh-exec";
import { readMetricsConfig, resolveStackHost } from "@/lib/metrics-config";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const ALLOWED = new Set(["grafana", "prometheus"]);

/**
 * Tail systemd logs for the metrics stack services. Read-only.
 * SSHes through the controller; if the stack lives on a worker we hop one
 * more time. journalctl is universal on systemd hosts and gives us the
 * unit's stdout/stderr without us having to know where Grafana writes its
 * own log files.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const service = url.searchParams.get("service") ?? "";
  if (!ALLOWED.has(service)) {
    return NextResponse.json({ error: "service must be grafana or prometheus" }, { status: 400 });
  }
  const linesRaw = Number(url.searchParams.get("lines") ?? "300");
  const lines = Number.isFinite(linesRaw) ? Math.max(50, Math.min(2000, Math.floor(linesRaw))) : 300;

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const metrics = readMetricsConfig(config);
  const stack = resolveStackHost(cluster.controllerHost, config, metrics);

  const target = await getClusterSshTarget(id);
  if (!target) return NextResponse.json({ error: "No SSH target" }, { status: 412 });
  const tgt = { ...target, bastion: cluster.sshBastion };

  // journalctl needs to run as root for full visibility; use sudo if not
  // already root. `--no-pager` so journalctl doesn't try to invoke `less`
  // and stall on a non-tty session.
  const inner = `S=""; [ "$(id -u)" != "0" ] && S="sudo"; $S journalctl -u ${service} -n ${lines} --no-pager 2>&1 || true`;

  let cmd: string;
  if (stack.isController) {
    cmd = inner;
  } else {
    const u = stack.user || "root";
    const p = stack.port || 22;
    cmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p ${p} ${u}@${stack.ip} bash -s <<'LOG_EOF'
set +e
${inner}
LOG_EOF`;
  }

  const r = await sshExecSimple(tgt, cmd);
  return NextResponse.json({
    service,
    host: stack.hostname,
    isController: stack.isController,
    lines,
    success: r.success,
    output: r.stdout,
    stderr: r.stderr,
  });
}
