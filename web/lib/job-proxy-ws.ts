/**
 * WebSocket upgrade handler for /job-proxy/<clusterId>/<jobId>/...
 *
 * Lives outside the Next.js request handler because route handlers don't get
 * access to the underlying socket. Wired into server.ts via
 * `server.on("upgrade", ...)`.
 *
 * Auth: pulls the NextAuth session JWT out of the cookie header and checks
 * the same membership rules as the HTTP route (owner / cluster admin / global
 * admin). On success, opens a WebSocket client to the upstream service over
 * the SSH tunnel and bridges frames bidirectionally between the browser-side
 * `ws` server connection and the upstream client connection. The `ws`
 * library handles the upgrade handshake on both sides — much more robust
 * than raw-socket header replay + byte piping.
 *
 * Returns a boolean: true if the upgrade was claimed (handler will respond
 * to the client). false to let the next handler try.
 */
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import { decode as decodeJwt } from "@auth/core/jwt";
import { prisma } from "./prisma";
import { resolveJobProxyTarget } from "./job-proxy";
import { getClusterSshTarget } from "./ssh-exec";
import { getJobTunnel } from "./job-tunnel";
import {
  JOB_PROXY_RE,
  parseCookies,
  safeCloseCode,
  stripProxyPrefix,
  WS_HOP_BY_HOP,
} from "./job-proxy-rewrite";

// One bridge WebSocketServer reused for every browser-side handshake. The
// server isn't bound to an http.Server because we feed it sockets via
// `handleUpgrade` directly. Cheap to keep around for the process lifetime.
const bridgeWss = new WebSocketServer({ noServer: true });

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
  const tag = `[job-proxy ws ${jobId.slice(0, 8)}]`;
  console.log(`${tag} upgrade ${rawUrl}`);

  const user = await readSession(req);
  if (!user) {
    console.log(`${tag} 401 — no decodable session cookie`);
    writeHttpError(socket, 401, "Unauthorized");
    return true;
  }
  const allowed = await authorize(clusterId, jobId, user);
  if (!allowed) {
    console.log(`${tag} 403 — user=${user.id} role=${user.role} not allowed`);
    writeHttpError(socket, 403, "Forbidden");
    return true;
  }

  const resolved = await resolveJobProxyTarget(clusterId, jobId);
  if (!resolved.ok) {
    console.log(`${tag} ${resolved.status} resolve: ${resolved.reason}`);
    writeHttpError(socket, resolved.status, resolved.reason);
    return true;
  }
  const { ip, proxyPort } = resolved.node;
  console.log(`${tag} resolved → ${ip}:${proxyPort}`);

  // Workers are private — go through the same SSH local-port-forward the
  // HTTP route uses so we end up talking to 127.0.0.1:<localPort>.
  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    select: { sshBastion: true },
  });
  const sshTarget = await getClusterSshTarget(clusterId);
  if (!sshTarget) {
    console.log(`${tag} 412 — no SSH target for cluster`);
    writeHttpError(socket, 412, "No SSH target");
    return true;
  }
  const tunnelTarget = { ...sshTarget, bastion: cluster?.sshBastion ?? false };
  let localPort: number;
  try {
    localPort = await getJobTunnel(clusterId, jobId, tunnelTarget, ip, proxyPort);
    console.log(`${tag} tunnel local=${localPort} → ${ip}:${proxyPort}`);
  } catch (e) {
    console.log(`${tag} 502 — tunnel: ${e instanceof Error ? e.message : "unknown"}`);
    writeHttpError(socket, 502, `Tunnel failed: ${e instanceof Error ? e.message : "unknown"}`);
    return true;
  }

  // Strip the /job-proxy/<clusterId>/<jobId> prefix before forwarding so
  // the upstream sees its native paths.
  const proxyPrefix = `/job-proxy/${clusterId}/${jobId}`;
  // rawUrl may include a query string; stripProxyPrefix handles only the
  // pathname portion, so split + rejoin around the `?`.
  const [rawPath, ...rest] = rawUrl.split("?");
  const upstreamPath = stripProxyPrefix(rawPath, proxyPrefix) + (rest.length ? "?" + rest.join("?") : "");

  const upstreamUrl = `ws://127.0.0.1:${localPort}${upstreamPath}`;
  console.log(`${tag} → upstream ${upstreamUrl}`);

  // Build the headers the WS client should forward upstream. Host is
  // replaced; hop-by-hop + WS handshake headers are stripped so `ws`
  // re-issues them with a fresh Sec-WebSocket-Key/Accept pair.
  const fwdHeaders: Record<string, string | string[]> = {
    Host: `127.0.0.1:${localPort}`,
  };
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (WS_HOP_BY_HOP.has(k.toLowerCase())) continue;
    fwdHeaders[k] = v;
  }

  // Preserve client-requested Sec-WebSocket-Protocol so the upstream sees
  // the same subprotocol list (Jupyter sometimes uses subprotocols for
  // version negotiation).
  const subprotocol = req.headers["sec-websocket-protocol"];
  const wsClientOptions: ConstructorParameters<typeof WebSocket>[2] = {
    headers: fwdHeaders,
    skipUTF8Validation: true,
  };

  let upstreamWs: WebSocket;
  try {
    upstreamWs = subprotocol
      ? new WebSocket(upstreamUrl, Array.isArray(subprotocol) ? subprotocol : [subprotocol], wsClientOptions)
      : new WebSocket(upstreamUrl, wsClientOptions);
  } catch (e) {
    console.log(`${tag} 502 — upstream WS init: ${e instanceof Error ? e.message : "unknown"}`);
    writeHttpError(socket, 502, "Upstream WebSocket init failed");
    return true;
  }

  // Defer the browser-side handshake until upstream connects (or fails).
  // We do NOT call wss.handleUpgrade until we know upstream accepted — if
  // we accept the browser side first and upstream then rejects, the
  // browser sees a connect-then-immediate-close which is exactly the
  // failure mode we've been chasing.
  const safeClose = (target: WebSocket, code: number, reason: Buffer) => {
    if (target.readyState !== WebSocket.OPEN && target.readyState !== WebSocket.CONNECTING) return;
    try {
      target.close(safeCloseCode(code), reason);
    } catch {
      // Last-ditch: if close() still rejects, just terminate.
      try { target.terminate(); } catch {}
    }
  };

  upstreamWs.once("open", () => {
    console.log(`${tag} upstream WS open, accepting browser handshake`);
    bridgeWss.handleUpgrade(req, socket, head, (browserWs) => {
      console.log(`${tag} bridge live`);
      // browser → upstream
      browserWs.on("message", (data, isBinary) => {
        if (upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.send(data, { binary: isBinary });
        }
      });
      browserWs.on("close", (code, reason) => {
        console.log(`${tag} browser WS close code=${code} reason=${reason.toString().slice(0, 80)}`);
        safeClose(upstreamWs, code, reason);
      });
      browserWs.on("error", (e) => console.log(`${tag} browser WS error: ${e.message}`));

      // upstream → browser
      upstreamWs.on("message", (data, isBinary) => {
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(data, { binary: isBinary });
        }
      });
      upstreamWs.on("close", (code, reason) => {
        console.log(`${tag} upstream WS close code=${code} reason=${reason.toString().slice(0, 80)}`);
        safeClose(browserWs, code, reason);
      });
      upstreamWs.on("error", (e) => console.log(`${tag} upstream WS error: ${e.message}`));
    });
  });

  upstreamWs.once("unexpected-response", (_clientReq, res) => {
    // Upstream returned a non-101 response to our upgrade — usually
    // 401/403/404. Translate to the browser as the same status so the
    // user sees something more useful than a generic close.
    console.log(`${tag} upstream rejected upgrade: HTTP ${res.statusCode}`);
    writeHttpError(socket, res.statusCode ?? 502, `Upstream returned ${res.statusCode}`);
    res.resume();
  });
  upstreamWs.once("error", (e) => {
    if (!socket.destroyed) {
      console.log(`${tag} upstream WS error pre-handshake: ${e.message}`);
      writeHttpError(socket, 502, `Upstream WS error: ${e.message}`);
    }
  });

  return true;
}
