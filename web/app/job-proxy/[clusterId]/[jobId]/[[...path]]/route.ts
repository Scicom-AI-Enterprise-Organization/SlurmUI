/**
 * Reverse-proxy a Slurm job's HTTP service through this Next.js app.
 *
 * Mounted at /job-proxy/<clusterId>/<jobId>/* — outside /api/ so the
 * proxied service has its full path namespace to itself.
 *
 * Auth: job owner OR cluster admin OR ADMIN role.
 *
 * The proxy STRIPS the /job-proxy/<clusterId>/<jobId> prefix before
 * forwarding so services that don't support a configurable base URL (vLLM,
 * generic FastAPI/Flask apps) work as-is — `/job-proxy/.../docs` becomes
 * `/docs` upstream. Trade-off: a service that emits absolute links like
 * `<script src="/static/x.js">` will have those links bypass the proxy
 * (the browser hits Aura at `/static/x.js` instead). Services with
 * configurable base paths (Jupyter `--ServerApp.base_url`, TensorBoard
 * `--path_prefix`) work better with relative-only HTML; for those, set
 * the base path to root and rely on relative URLs.
 *
 * WebSocket upgrades are handled separately in server.ts because Next.js
 * route handlers don't get access to the raw socket.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveJobProxyTarget } from "@/lib/job-proxy";
import { getClusterSshTarget } from "@/lib/ssh-exec";
import { dropJobTunnel, getJobTunnel } from "@/lib/job-tunnel";
import {
  HTTP_HOP_BY_HOP,
  HTTP_RESP_STRIP,
  injectOpenApiServers,
  rewriteHtmlAbsolutePaths,
  rewriteLocationHeader,
  rewriteSetCookiePath,
  stripProxyPrefix,
} from "@/lib/job-proxy-rewrite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ clusterId: string; jobId: string; path?: string[] }>;
}

async function authorize(clusterId: string, jobId: string) {
  const session = await auth();
  if (!session?.user) return { ok: false as const, status: 401 };
  const userId = (session.user as { id?: string }).id;
  const role = (session.user as { role?: string }).role;
  if (role === "ADMIN") return { ok: true as const };
  if (!userId) return { ok: false as const, status: 401 };

  const job = await prisma.job.findFirst({
    where: { id: jobId, clusterId },
    select: { userId: true },
  });
  if (!job) return { ok: false as const, status: 404 };
  if (job.userId === userId) return { ok: true as const };
  // Anyone with ACTIVE ClusterUser membership on the cluster can also view —
  // the proxy is essentially "look at this job's running service", same gate
  // as the metrics tab.
  const cu = await prisma.clusterUser.findFirst({
    where: { clusterId, userId, status: "ACTIVE" as const },
    select: { id: true },
  });
  if (cu) return { ok: true as const };
  return { ok: false as const, status: 403 };
}

async function handle(req: NextRequest, clusterId: string, jobId: string) {
  const authz = await authorize(clusterId, jobId);
  if (!authz.ok) return NextResponse.json({ error: "Forbidden" }, { status: authz.status });

  const resolved = await resolveJobProxyTarget(clusterId, jobId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.reason }, { status: resolved.status });
  }
  const { ip, proxyPort } = resolved.node;

  // Workers typically live on a private network only the controller can
  // reach. Use an SSH local-port-forward through the controller (mirror of
  // the Grafana proxy pattern) so the web server talks to 127.0.0.1.
  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    select: { sshBastion: true },
  });
  const sshTarget = await getClusterSshTarget(clusterId);
  if (!sshTarget) {
    return NextResponse.json({ error: "No SSH target for cluster" }, { status: 412 });
  }
  const tunnelTarget = { ...sshTarget, bastion: cluster?.sshBastion ?? false };
  let localPort: number;
  try {
    localPort = await getJobTunnel(clusterId, jobId, tunnelTarget, ip, proxyPort);
  } catch (e) {
    return NextResponse.json(
      { error: "Tunnel failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  // Strip the /job-proxy/<clusterId>/<jobId> prefix so the upstream sees
  // its native paths (`/docs`, `/openapi.json`, etc).
  const proxyPrefix = `/job-proxy/${clusterId}/${jobId}`;
  const fullPath = stripProxyPrefix(req.nextUrl.pathname, proxyPrefix) + (req.nextUrl.search ?? "");
  const upstream = `http://127.0.0.1:${localPort}${fullPath}`;

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (HTTP_HOP_BY_HOP.has(k.toLowerCase())) return;
    headers.set(k, v);
  });
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const xfHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  if (proto) headers.set("x-forwarded-proto", proto);
  if (xfHost) headers.set("x-forwarded-host", xfHost);
  // Tell prefix-aware frameworks (FastAPI w/ proxy_headers, Werkzeug,
  // Spring's ForwardedHeaderFilter, etc.) the URL prefix the user sees so
  // their emitted absolute links can include it. The upstream still
  // receives the stripped path; this header is purely informational.
  headers.set("x-forwarded-prefix", proxyPrefix);
  // Make undici use a fresh socket per request — the upstream might be a
  // user's hand-rolled server with idiosyncratic keep-alive behaviour.
  headers.set("connection", "close");

  const init: RequestInit & { keepalive?: boolean } = {
    method: req.method,
    headers,
    redirect: "manual",
    keepalive: false,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.arrayBuffer();
    if (body.byteLength > 0) (init as RequestInit & { body: ArrayBuffer }).body = body;
  }

  // Treat socket-level failures as "tunnel might be stale" — drop the pool
  // entry and retry once with a freshly-built tunnel. Same set of codes the
  // grafana proxy retries on.
  const RETRY_CODES = new Set([
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE",
    "UND_ERR_SOCKET", "UND_ERR_SOCKET_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
  ]);
  const errCode = (e: unknown): string | undefined =>
    (e as { cause?: { code?: string } } | null)?.cause?.code;

  let upRes: Response | null = null;
  let lastErr: unknown = null;
  let lastUrl = upstream;
  try {
    upRes = await fetch(upstream, init);
  } catch (e1) {
    lastErr = e1;
    const code = errCode(e1);
    if (code && RETRY_CODES.has(code)) {
      dropJobTunnel(clusterId, jobId);
      try {
        const fresh = await getJobTunnel(clusterId, jobId, tunnelTarget, ip, proxyPort);
        lastUrl = `http://127.0.0.1:${fresh}${fullPath}`;
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
          const c = cause as { code?: string; message?: string };
          return c.code || c.message;
        })()
      : undefined;
    return NextResponse.json(
      {
        error: "Upstream fetch failed",
        detail: msg,
        cause: causeStr,
        upstream: `http://${ip}:${proxyPort} (via SSH tunnel)`,
      },
      { status: 502 },
    );
  }

  const respHeaders = new Headers();
  upRes.headers.forEach((v, k) => {
    const kl = k.toLowerCase();
    if (HTTP_RESP_STRIP.has(kl)) return;
    if (kl === "set-cookie") return;
    respHeaders.set(k, v);
  });
  // Diagnostic: surface the exact path + status we got from upstream so the
  // user can verify what Jupyter / vLLM / whatever actually saw, separate
  // from any rewriting we do on the way back. Cheap to read in DevTools.
  respHeaders.set("x-aura-proxy-upstream", `${ip}:${proxyPort}${fullPath}`);
  respHeaders.set("x-aura-proxy-status", String(upRes.status));
  // Multi-Set-Cookie preservation. Same trick as grafana-proxy — forEach
  // folds them into a comma-joined value which is wrong.
  const setCookies = (upRes.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];

  // Location header rewriting — must run BEFORE the body-branch returns
  // below, otherwise a 302 with `Content-Type: text/html` (Jupyter's `/`
  // → `/tree` redirect, for one) gets caught by the HTML branch and the
  // unmodified `Location: /tree` reaches the browser, jumping the user
  // out of the proxy.
  const rewrittenLoc = rewriteLocationHeader(respHeaders.get("location"), proxyPrefix);
  if (rewrittenLoc) respHeaders.set("location", rewrittenLoc);

  // Set-Cookie path rewriting. Cookies set with `Path=/specific/sub` won't
  // be sent for proxied requests under `/job-proxy/...`; prepend the
  // prefix so the cookie scope still matches.
  for (const c of setCookies) {
    respHeaders.append("set-cookie", rewriteSetCookiePath(c, proxyPrefix));
  }

  // Body rewriting for HTML responses. Many services (vLLM/FastAPI's Swagger
  // UI, simple Flask apps) emit absolute-path URLs like `url: "/openapi.json"`
  // or `<a href="/login">`. Since we strip the proxy prefix on the way
  // upstream, those paths bypass the proxy when the browser resolves them.
  const ct = (upRes.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("text/html")) {
    const text = await upRes.text();
    return new NextResponse(rewriteHtmlAbsolutePaths(text, proxyPrefix), {
      status: upRes.status,
      headers: respHeaders,
    });
  }

  // OpenAPI / Swagger spec rewriting — inject `servers` so Swagger UI's
  // "Try it out" curl examples build requests against the proxy prefix.
  if (ct.includes("application/json")) {
    const text = await upRes.text();
    const xfHost2 = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? undefined;
    const rewritten = injectOpenApiServers(text, proxyPrefix, xfHost2);
    if (rewritten) {
      return new NextResponse(rewritten, { status: upRes.status, headers: respHeaders });
    }
    return new NextResponse(text, { status: upRes.status, headers: respHeaders });
  }

  return new NextResponse(upRes.body, {
    status: upRes.status,
    headers: respHeaders,
  });
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { clusterId, jobId } = await params;
  return handle(req, clusterId, jobId);
}
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { clusterId, jobId } = await params;
  return handle(req, clusterId, jobId);
}
export async function PUT(req: NextRequest, { params }: RouteParams) {
  const { clusterId, jobId } = await params;
  return handle(req, clusterId, jobId);
}
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { clusterId, jobId } = await params;
  return handle(req, clusterId, jobId);
}
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { clusterId, jobId } = await params;
  return handle(req, clusterId, jobId);
}
export async function OPTIONS(req: NextRequest, { params }: RouteParams) {
  const { clusterId, jobId } = await params;
  return handle(req, clusterId, jobId);
}
export async function HEAD(req: NextRequest, { params }: RouteParams) {
  const { clusterId, jobId } = await params;
  return handle(req, clusterId, jobId);
}
