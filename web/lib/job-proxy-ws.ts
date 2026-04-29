/**
 * WebSocket upgrade handler for /job-proxy/<clusterId>/<jobId>/...
 *
 * Lives outside the Next.js request handler because route handlers don't get
 * access to the underlying socket. Wired into server.ts via
 * `server.on("upgrade", ...)`.
 *
 * Auth: pulls the NextAuth session JWT out of the cookie header and checks
 * the same membership rules as the HTTP route (owner / cluster admin / global
 * admin). On success, opens a TCP connection to <jobNode>:<proxyPort>, replays
 * the original request line + headers (with Connection: Upgrade preserved),
 * then pipes both sockets in both directions.
 *
 * Returns a boolean: true if the upgrade was claimed (handler will respond
 * to the client). false to let the next handler try.
 */
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { connect } from "net";
import { decode as decodeJwt } from "@auth/core/jwt";
import { prisma } from "./prisma";
import { resolveJobProxyTarget } from "./job-proxy";
import { getClusterSshTarget } from "./ssh-exec";
import { getJobTunnel } from "./job-tunnel";

const JOB_PROXY_RE = /^\/job-proxy\/([^\/]+)\/([^\/]+)(\/.*)?$/;

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const pair of header.split(/;\s*/)) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

interface SessionUser { id: string; role: string }

/**
 * Decode the NextAuth session JWT. Tries both the secure-prefix and the
 * unprefixed cookie names (production sets the secure prefix when on HTTPS,
 * dev compose serves over plain HTTP).
 */
async function readSession(req: IncomingMessage): Promise<SessionUser | null> {
  const cookies = parseCookies(req.headers.cookie);
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return null;

  // Cookie names NextAuth v5 emits.
  const candidates = [
    "__Secure-authjs.session-token",
    "authjs.session-token",
    // v4 names — kept for backwards-compat in case an old deploy still uses them.
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
  ];
  for (const name of candidates) {
    const token = cookies[name];
    if (!token) continue;
    try {
      const decoded = await decodeJwt({ token, secret, salt: name }) as { userId?: string; role?: string } | null;
      if (decoded?.userId && decoded.role) {
        return { id: decoded.userId, role: decoded.role };
      }
    } catch {
      // Try next candidate — wrong salt/cookie name will throw.
    }
  }
  return null;
}

async function authorize(clusterId: string, jobId: string, user: SessionUser): Promise<boolean> {
  if (user.role === "ADMIN") return true;
  const job = await prisma.job.findFirst({
    where: { id: jobId, clusterId },
    select: { userId: true },
  });
  if (!job) return false;
  if (job.userId === user.id) return true;
  const cu = await prisma.clusterUser.findFirst({
    where: { clusterId, userId: user.id, status: "ACTIVE" as const },
    select: { id: true },
  });
  return !!cu;
}

function writeHttpError(socket: Duplex, status: number, message: string) {
  const body = `${status} ${message}`;
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
    `Connection: close\r\n` +
    `Content-Type: text/plain\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `\r\n` +
    body,
  );
  socket.destroy();
}

function rebuildHeaders(req: IncomingMessage, upstreamPath: string): string {
  // First line: keep the method/version, but use the prefix-stripped path.
  // Mirrors what the HTTP route does — the upstream sees its native paths
  // (`/ws`, etc.) instead of `/job-proxy/<cluster>/<job>/ws`.
  const method = req.method ?? "GET";
  const httpVersion = req.httpVersion ?? "1.1";
  const lines: string[] = [`${method} ${upstreamPath} HTTP/${httpVersion}`];

  // Drop the Cookie header so the user's Aura session cookie doesn't leak
  // into the user's job process. Most upstream services don't need it; if a
  // service later proves to want some cookie pass-through we can revisit.
  // We DO preserve the Upgrade / Sec-WebSocket-* / Connection headers
  // verbatim — those are the WS handshake.
  const dropped = new Set(["host", "cookie"]);
  for (const [k, vRaw] of Object.entries(req.headers)) {
    if (vRaw === undefined) continue;
    if (dropped.has(k.toLowerCase())) continue;
    const values = Array.isArray(vRaw) ? vRaw : [vRaw];
    for (const v of values) lines.push(`${k}: ${v}`);
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

/**
 * Try to handle an HTTP upgrade as a job-proxy WS. Returns true if the
 * URL matched and the handler took over the socket; false if the URL
 * isn't ours and the caller should hand it to the next handler.
 */
export async function tryHandleJobProxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<boolean> {
  const rawUrl = req.url ?? "";
  const m = rawUrl.split("?")[0].match(JOB_PROXY_RE);
  if (!m) return false;
  const clusterId = m[1];
  const jobId = m[2];

  const user = await readSession(req);
  if (!user) {
    writeHttpError(socket, 401, "Unauthorized");
    return true;
  }
  const allowed = await authorize(clusterId, jobId, user);
  if (!allowed) {
    writeHttpError(socket, 403, "Forbidden");
    return true;
  }

  const resolved = await resolveJobProxyTarget(clusterId, jobId);
  if (!resolved.ok) {
    writeHttpError(socket, resolved.status, resolved.reason);
    return true;
  }
  const { ip, proxyPort } = resolved.node;

  // Workers are private — go through the same SSH local-port-forward the
  // HTTP route uses so we end up talking to 127.0.0.1:<localPort>.
  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    select: { sshBastion: true },
  });
  const sshTarget = await getClusterSshTarget(clusterId);
  if (!sshTarget) {
    writeHttpError(socket, 412, "No SSH target");
    return true;
  }
  const tunnelTarget = { ...sshTarget, bastion: cluster?.sshBastion ?? false };
  let localPort: number;
  try {
    localPort = await getJobTunnel(clusterId, jobId, tunnelTarget, ip, proxyPort);
  } catch (e) {
    writeHttpError(socket, 502, `Tunnel failed: ${e instanceof Error ? e.message : "unknown"}`);
    return true;
  }

  // Strip the /job-proxy/<clusterId>/<jobId> prefix before replaying.
  const prefix = `/job-proxy/${clusterId}/${jobId}`;
  let upstreamPath = rawUrl;
  if (upstreamPath.startsWith(prefix)) {
    upstreamPath = upstreamPath.slice(prefix.length) || "/";
  }
  if (!upstreamPath.startsWith("/")) upstreamPath = "/" + upstreamPath;

  // Open a raw TCP socket to the local tunnel end and replay the upgrade
  // request. The upstream WebSocket server will respond with its own 101
  // Switching Protocols handshake, which we forward to the browser
  // unchanged. From there it's a bidirectional byte pipe.
  const upstream = connect({ host: "127.0.0.1", port: localPort }, () => {
    upstream.write(rebuildHeaders(req, upstreamPath));
    if (head && head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.setNoDelay(true);
  // socket is typed as Duplex in the upgrade event but is actually a
  // net.Socket — call setNoDelay through a guard so we don't crash if a
  // future runtime swaps to a non-TCP duplex.
  const sd = socket as unknown as { setNoDelay?: (b: boolean) => void };
  if (typeof sd.setNoDelay === "function") sd.setNoDelay(true);

  const cleanup = () => {
    try { upstream.destroy(); } catch {}
    try { socket.destroy(); } catch {}
  };
  upstream.on("error", () => {
    if (!socket.destroyed) writeHttpError(socket, 502, "Upstream connection failed");
    cleanup();
  });
  socket.on("error", cleanup);
  upstream.on("close", cleanup);
  socket.on("close", cleanup);

  return true;
}
