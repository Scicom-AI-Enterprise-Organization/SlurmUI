/**
 * Reverse-proxy a cluster's Grafana through this Next.js app.
 *
 * Mounted at /grafana-proxy/<clusterId>/* — deliberately OUTSIDE /api/
 * because Grafana has its own /api/* namespace and routing collisions cause
 * it to return its own 404s for any path beginning with /api/.
 *
 * Grafana is on the stack host (controller or chosen worker). We tunnel
 * SSH-local-forward to it (see grafana-tunnel.ts) and forward all HTTP
 * traffic verbatim — binary assets, POST bodies, etc.
 *
 * Auth: same as the prometheus query proxy — admin or active ClusterUser.
 *
 * Grafana must be configured (in grafana.ini) with:
 *   root_url = <aura-origin>/grafana-proxy/<clusterId>/
 *   serve_from_sub_path = true
 * so its bundled HTML embeds the prefix in every asset URL AND its router
 * strips the prefix from incoming requests. The deploy route writes that
 * config.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getClusterSshTarget } from "@/lib/ssh-exec";
import { readMetricsConfig, resolveStackHost } from "@/lib/metrics-config";
import { dropGrafanaTunnel, getGrafanaTunnel } from "@/lib/grafana-tunnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  // Optional catch-all — `path` is undefined when the URL is exactly
  // `/grafana-proxy/<id>` with no trailing segments.
  params: Promise<{ id: string; path?: string[] }>;
}

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

async function handle(req: NextRequest, clusterId: string, pathSegs: string[]) {
  const authz = await authorize(clusterId);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: authz.status });

  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey) {
    return NextResponse.json({ error: "Cluster not configured" }, { status: 412 });
  }
  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const metrics = readMetricsConfig(config);
  if (!metrics.enabled) {
    return NextResponse.json({ error: "Metrics disabled" }, { status: 412 });
  }

  const stack = resolveStackHost(cluster.controllerHost, config, metrics);
  const target = await getClusterSshTarget(clusterId);
  if (!target) return NextResponse.json({ error: "No SSH target" }, { status: 412 });

  const grafanaIp = stack.isController ? "127.0.0.1" : stack.ip;
  // Spread bastion onto the tunnel target — getClusterSshTarget doesn't
  // include it, but the tunnel needs to know to keep the channel open
  // with `-tt` + sleep on bastion-mode controllers.
  const tunnelTarget = { ...target, bastion: cluster.sshBastion };
  let localPort: number;
  try {
    localPort = await getGrafanaTunnel(clusterId, tunnelTarget, grafanaIp, metrics.grafanaPort);
  } catch (e) {
    return NextResponse.json(
      { error: "Tunnel failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  // Forward the FULL prefixed path. Grafana is configured with
  // serve_from_sub_path=true, so it strips the configured root_url prefix
  // itself before dispatching. If we strip here too, Grafana would 404
  // because its router wouldn't recognise the bare `/whatever` path.
  const subPath = pathSegs.join("/");
  const qs = req.nextUrl.search ?? "";
  const upstreamPath = `/grafana-proxy/${clusterId}/${subPath}${qs}`;
  const upstream = `http://127.0.0.1:${localPort}${upstreamPath}`;

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    const kl = k.toLowerCase();
    // Drop hop-by-hop and node-fetch-managed headers. Also drop the
    // browser's own Authorization header so our injected Basic auth wins.
    if (kl === "host" || kl === "connection" || kl === "content-length"
        || kl === "accept-encoding" || kl === "authorization") return;
    headers.set(k, v);
  });
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const xfHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  if (proto) headers.set("x-forwarded-proto", proto);
  if (xfHost) headers.set("x-forwarded-host", xfHost);

  // Grafana doesn't know about our session, so server-inject Basic auth
  // on every proxied request using the admin password we generated at
  // deploy. Aura's own authorize() above already gated who reaches here.
  if (metrics.grafanaAdminPassword) {
    const basic = Buffer.from(`admin:${metrics.grafanaAdminPassword}`).toString("base64");
    headers.set("authorization", `Basic ${basic}`);
  }

  // Disable HTTP keep-alive on the upstream side. undici aggressively pools
  // sockets, but our SSH tunnel can silently drop a forwarded TCP socket
  // (e.g. after a Grafana restart) without invalidating undici's pooled
  // entry — the next request then explodes with UND_ERR_SOCKET. Forcing a
  // fresh socket per request avoids that.
  const init: RequestInit & { keepalive?: boolean } = {
    method: req.method,
    headers,
    redirect: "manual",
    keepalive: false,
  };
  // Tell the server to close the socket after this response too, so undici
  // doesn't even consider keeping it.
  headers.set("connection", "close");
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.arrayBuffer();
    if (body.byteLength > 0) (init as RequestInit & { body: ArrayBuffer }).body = body;
  }

  // Try the upstream fetch; on connection refused / reset (likely sign the
  // cached tunnel is talking to a Grafana that just restarted), drop the
  // tunnel and retry ONCE with a freshly-built one.
  const buildUpstreamUrl = (port: number) =>
    `http://127.0.0.1:${port}/grafana-proxy/${clusterId}/${subPath}${qs}`;
  const errCode = (e: unknown): string | undefined =>
    (e as { cause?: { code?: string } } | null)?.cause?.code;

  // Treat any socket-level failure as "tunnel might be stale" — drop the
  // pool and retry once. Covers: ECONNREFUSED / ECONNRESET / ETIMEDOUT
  // (network-level), UND_ERR_SOCKET / UND_ERR_SOCKET_TIMEOUT (undici
  // detected the socket misbehaved mid-request).
  const RETRY_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "UND_ERR_SOCKET",
    "UND_ERR_SOCKET_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ]);

  let upRes: Response | null = null;
  let lastErr: unknown = null;
  let lastUrl = upstream;
  try {
    upRes = await fetch(upstream, init);
  } catch (e1) {
    lastErr = e1;
    const code = errCode(e1);
    if (code && RETRY_CODES.has(code)) {
      dropGrafanaTunnel(clusterId);
      try {
        localPort = await getGrafanaTunnel(clusterId, tunnelTarget, grafanaIp, metrics.grafanaPort);
        lastUrl = buildUpstreamUrl(localPort);
        upRes = await fetch(lastUrl, init);
        lastErr = null;
      } catch (e2) {
        lastErr = e2;
      }
    }
  }
  if (!upRes) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const cause = lastErr instanceof Error && (lastErr as Error & { cause?: unknown }).cause;
    const causeStr = cause
      ? (() => {
          if (typeof cause === "string") return cause;
          const c = cause as { code?: string; message?: string; errno?: number };
          return c.code || c.message || JSON.stringify(c);
        })()
      : undefined;
    return NextResponse.json(
      {
        error: "Upstream fetch failed",
        detail: msg,
        cause: causeStr,
        upstream: lastUrl,
        localPort,
        grafanaIp,
        grafanaPort: metrics.grafanaPort,
      },
      { status: 502 },
    );
  }

  const respHeaders = new Headers();
  upRes.headers.forEach((v, k) => {
    const kl = k.toLowerCase();
    // Strip hop-by-hop / encoding headers — Next will set them as needed.
    if (kl === "content-encoding" || kl === "content-length" || kl === "transfer-encoding" || kl === "connection") return;
    // forEach folds multiple Set-Cookie headers into a single
    // comma-joined string (which is invalid because Cookie values can
    // contain commas), so handle them via getSetCookie() below instead.
    if (kl === "set-cookie") return;
    respHeaders.set(k, v);
  });
  // Preserve every individual Set-Cookie header (Grafana's session cookie
  // among them) — without this the browser never gets the session, every
  // page revalidates against our injected Basic auth, and any flow that
  // depends on the cookie (login, switch org) silently fails.
  const setCookies = (upRes.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const c of setCookies) respHeaders.append("set-cookie", c);

  // Origin rewrite. Grafana bakes `root_url` into HTML/JSON at startup, so
  // any deploy-time host (e.g. localhost:3001 from a dev deploy) leaks
  // into the responses. Swap it for the request's actual origin so users
  // browsing from prod don't get assets / API calls pointing at the dev
  // origin. Only touches text-y content types — binary assets pass
  // through verbatim.
  const bakedRoot = (metrics.grafanaRootUrl ?? "").replace(/\/+$/, "");
  let bakedOrigin = "";
  if (bakedRoot) {
    try { bakedOrigin = new URL(bakedRoot).origin; } catch {}
  }
  const reqProto = (req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "")).split(",")[0].trim();
  const reqHost = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
  const currentOrigin = reqHost ? `${reqProto}://${reqHost}` : "";
  const ct = (upRes.headers.get("content-type") ?? "").toLowerCase();
  const rewritable =
    bakedOrigin && currentOrigin && bakedOrigin !== currentOrigin &&
    (ct.includes("text/html") ||
     ct.includes("application/json") ||
     ct.includes("application/javascript") ||
     ct.includes("text/javascript") ||
     ct.includes("text/css"));
  if (rewritable) {
    const text = await upRes.text();
    // Replace bare-origin matches (most common — `<base href="<origin>/grafana-proxy/...">`,
    // bootstrap config JSON, redirect URLs). Body URLs that are origin-relative
    // (e.g. `/grafana-proxy/<id>/public/build/foo.js`) already work because the
    // browser resolves them against its own origin, no rewrite needed.
    const fixed = text.split(bakedOrigin).join(currentOrigin);
    return new NextResponse(fixed, { status: upRes.status, headers: respHeaders });
  }

  return new NextResponse(upRes.body, {
    status: upRes.status,
    headers: respHeaders,
  });
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id, path } = await params;
  return handle(req, id, path ?? []);
}
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id, path } = await params;
  return handle(req, id, path ?? []);
}
export async function PUT(req: NextRequest, { params }: RouteParams) {
  const { id, path } = await params;
  return handle(req, id, path ?? []);
}
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id, path } = await params;
  return handle(req, id, path ?? []);
}
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, path } = await params;
  return handle(req, id, path ?? []);
}
export async function OPTIONS(req: NextRequest, { params }: RouteParams) {
  const { id, path } = await params;
  return handle(req, id, path ?? []);
}
