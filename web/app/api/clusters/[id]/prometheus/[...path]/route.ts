/**
 * Proxy PromQL HTTP requests to the controller-resident Prometheus.
 *
 * We don't open a persistent SSH port-forward. Instead each call SSHes into
 * the controller and runs `curl` against 127.0.0.1:<promPort>, then returns
 * the body verbatim. This keeps the proxy stateless and avoids leaking
 * port-forward processes on dev reloads.
 *
 * Auth model: any cluster member (ClusterUser ACTIVE) or admin may issue
 * queries. The query goes through the controller's loopback Prometheus,
 * which has no auth, so it's important we don't expose this proxy publicly
 * without a session.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple, getClusterSshTarget } from "@/lib/ssh-exec";
import { readMetricsConfig, resolveStackHost } from "@/lib/metrics-config";

interface RouteParams {
  params: Promise<{ id: string; path: string[] }>;
}

const ALLOWED_PATHS = new Set([
  "api/v1/query",
  "api/v1/query_range",
  "api/v1/series",
  "api/v1/labels",
  "api/v1/label/__name__/values",
  "api/v1/targets",
  "api/v1/status/buildinfo",
]);

async function authorize(clusterId: string) {
  const session = await auth();
  if (!session?.user) return { ok: false as const, status: 401 };
  const userId = (session.user as { id?: string }).id;
  const role = (session.user as { role?: string }).role;
  if (role === "ADMIN") return { ok: true as const };
  if (!userId) return { ok: false as const, status: 401 };
  const cu = await prisma.clusterUser.findFirst({
    where: { clusterId, userId, status: "ACTIVE" as const },
    select: { id: true },
  });
  if (!cu) return { ok: false as const, status: 403 };
  return { ok: true as const };
}

async function proxy(req: NextRequest, clusterId: string, pathSegs: string[]) {
  const authz = await authorize(clusterId);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: authz.status });

  // Whitelist the proxied paths — Prometheus's admin endpoints
  // (/-/reload, /-/quit, /api/v1/admin/*) stay locked to the controller.
  // /api/v1/label/<name>/values is parameterised; allow any single-segment
  // <name> that ends in `values`.
  const subPath = pathSegs.join("/");
  const labelMatch = /^api\/v1\/label\/[^/]+\/values$/.test(subPath);
  if (!ALLOWED_PATHS.has(subPath) && !labelMatch) {
    return NextResponse.json({ error: "Path not allowed" }, { status: 404 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const metrics = readMetricsConfig(config);
  if (!metrics.enabled) {
    return NextResponse.json({ error: "Metrics disabled for this cluster" }, { status: 412 });
  }

  const target = await getClusterSshTarget(clusterId);
  if (!target) return NextResponse.json({ error: "No SSH target" }, { status: 412 });
  const tgt = { ...target, bastion: cluster.sshBastion };

  // Reconstruct the query body. For GET we forward the original querystring;
  // for POST we read the urlencoded form body.
  let bodyPart = "";
  if (req.method === "POST") {
    const text = await req.text();
    if (text) bodyPart = `--data ${shellQuote(text)}`;
  }
  const qs = req.nextUrl.search ?? "";
  // Always run curl on the controller — but aim it at whichever host
  // actually runs the stack. For controller-hosted stacks that's loopback;
  // for worker-hosted stacks we hit the worker's IP across the cluster's
  // private network.
  const stack = resolveStackHost(cluster.controllerHost, config, metrics);
  const stackIp = stack.isController ? "127.0.0.1" : stack.ip;
  const url = `http://${stackIp}:${metrics.prometheusPort}/${subPath}${qs}`;

  // -w prints the HTTP code on its own line at the end so we can demux
  // body vs status without hitting curl's header-mode in PTY-based bastion
  // sessions (which corrupt -i header parsing). The TRAILING `\\n` is
  // critical: without it, the bastion-mux wrapper's `echo __AURA_CMD_END…`
  // glues onto the same buffered line as our marker, the mux sees the
  // END marker first and discards the whole line — every 200 mis-mapped
  // to a 502.
  const cmd = `curl -sS --max-time 15 ${bodyPart} -w '\\n__AURA_HTTP__:%{http_code}\\n' ${shellQuote(url)}`;
  const r = await sshExecSimple(tgt, cmd);
  if (!r.success) {
    return NextResponse.json({ error: "Upstream SSH failed", detail: r.stderr || "ssh exited nonzero" }, { status: 502 });
  }
  // Find the trailer marker anywhere near the end (not anchored), tolerant
  // of trailing CR / NL noise that the bastion PTY likes to introduce. The
  // previous anchored regex would miss when stdout ended in `\r\n` instead
  // of plain `\n`, causing every successful 200 to be mis-mapped to 502.
  const out = r.stdout;
  const idx = out.lastIndexOf("__AURA_HTTP__:");
  let code = 502;
  let body = out;
  if (idx !== -1) {
    const tail = out.slice(idx + "__AURA_HTTP__:".length).trim();
    const cm = tail.match(/^(\d{3})/);
    if (cm) code = Number(cm[1]);
    // Strip the marker (and the leading \n curl printed before it) from body.
    body = out.slice(0, idx).replace(/[\r\n]+$/, "");
  }
  return new NextResponse(body, {
    status: code,
    headers: { "Content-Type": "application/json" },
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id, path } = await params;
  return proxy(req, id, path ?? []);
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id, path } = await params;
  return proxy(req, id, path ?? []);
}
