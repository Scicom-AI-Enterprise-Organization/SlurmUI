/**
 * Pure URL / header / body rewriting helpers for the job proxy.
 *
 * Extracted from `app/job-proxy/[clusterId]/[jobId]/[[...path]]/route.ts`
 * and `lib/job-proxy-ws.ts` so they can be unit-tested in isolation
 * without spinning up Next, Prisma, or the SSH tunnel layer.
 *
 * Every function here is referentially transparent — same input always
 * produces the same output, no I/O, no globals.
 */

/** Match `/job-proxy/<clusterId>/<jobId>` (and optional trailing path). */
export const JOB_PROXY_RE = /^\/job-proxy\/([^\/]+)\/([^\/]+)(\/.*)?$/;

/**
 * Strip the `/job-proxy/<clusterId>/<jobId>` prefix from a pathname so the
 * upstream service sees its native path. Always returns a leading-slash
 * path. Empty result becomes `/`.
 */
export function stripProxyPrefix(pathname: string, prefix: string): string {
  let stripped = pathname;
  if (stripped.startsWith(prefix)) stripped = stripped.slice(prefix.length) || "/";
  if (!stripped.startsWith("/")) stripped = "/" + stripped;
  return stripped;
}

/** WebSocket close codes 1005 (no-status) / 1006 (abnormal) are reserved
 * for the local stack and MUST NOT appear on the wire — `ws.close()` throws
 * if you pass them. Map to 1000 (normal closure). */
export function safeCloseCode(code: number): number {
  return code === 1005 || code === 1006 ? 1000 : code;
}

/** Parse an HTTP `Cookie:` header into a name → value map. URL-decodes values. */
export function parseCookies(header: string | undefined): Record<string, string> {
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

/**
 * Rewrite quoted absolute paths in HTML so they round-trip through the
 * proxy. Targets `"/foo"` and `'/foo'` style quoted strings, skips
 * protocol-relative `"//cdn"` and already-prefixed paths.
 *
 * We rewrite EVERYTHING in the response, including inline `<script>` and
 * `<style>` bodies — this matters for Jupyter Notebook's
 * `requirejs.config({ baseUrl: "/static/..." })` and similar setups
 * where module loaders read URLs out of inline JS string literals.
 *
 * Originally I skipped script bodies to preserve `script-src` sha256
 * hashes pinned by code-server's CSP. That's no longer necessary
 * because the route handler strips the upstream `Content-Security-Policy`
 * header (proxy access is already auth-gated). With CSP gone, mutating
 * the body is safe.
 */
export function rewriteHtmlAbsolutePaths(html: string, proxyPrefix: string): string {
  const tail = proxyPrefix.startsWith("/") ? proxyPrefix.slice(1) : proxyPrefix;
  const escapedTail = tail.replace(/\//g, "\\/");
  const re = new RegExp(`(["'])(\\/(?!\\/)(?!${escapedTail}(?:\\/|\\1))[^"']*)\\1`, "g");
  return html.replace(re, (_m, q: string, p: string) => `${q}${proxyPrefix}${p}${q}`);
}

/**
 * For OpenAPI / Swagger spec JSON, inject `servers` (3.x) or `basePath`
 * (2.0) so Swagger UI's "Try it out" curl examples target the proxy
 * instead of the page origin. Returns null when the JSON isn't an OpenAPI
 * doc (caller passes through unchanged).
 */
export function injectOpenApiServers(
  text: string,
  proxyPrefix: string,
  swaggerHost?: string,
): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as { openapi?: unknown; swagger?: unknown; servers?: unknown; basePath?: unknown; host?: unknown };
  if (o.openapi) {
    o.servers = [{ url: proxyPrefix, description: "Aura job proxy" }];
    return JSON.stringify(obj);
  }
  if (o.swagger) {
    o.basePath = proxyPrefix;
    if (swaggerHost) o.host = swaggerHost;
    return JSON.stringify(obj);
  }
  return null;
}

/** Prepend the proxy prefix to a Location header value when it's a bare
 * absolute path that isn't already prefixed. Protocol-relative `//host`
 * and full URLs are left alone. Returns null when no rewrite is needed. */
export function rewriteLocationHeader(loc: string | null, proxyPrefix: string): string | null {
  if (!loc) return null;
  if (!loc.startsWith("/")) return null;
  if (loc.startsWith("//")) return null;
  if (loc.startsWith(`${proxyPrefix}/`) || loc === proxyPrefix) return null;
  return `${proxyPrefix}${loc}`;
}

/** Rewrite the `Path=` attribute on a Set-Cookie header so cookies scoped
 * to `/foo` instead become scoped to `/<prefix>/foo`. Cookies missing a
 * Path attribute are returned unchanged. */
export function rewriteSetCookiePath(setCookie: string, proxyPrefix: string): string {
  return setCookie.replace(
    /(;\s*Path=)(\/[^;]*)/i,
    (_m, lead: string, p: string) =>
      p.startsWith(`${proxyPrefix}/`) || p === proxyPrefix
        ? `${lead}${p}`
        : `${lead}${proxyPrefix}${p === "/" ? "/" : p}`,
  );
}

/**
 * Force a `<base href="<proxyPrefix>/">` into the HTML so relative URL
 * resolution is anchored to the proxy prefix, not the page URL. Without
 * this, code-server / any framework emitting relative asset paths
 * (`<link href="static/foo.css">`) gets bitten by the trailing-slash
 * problem — page URL `/job-proxy/<c>/<j>` (no slash) means the browser
 * drops `<j>` like a filename and resolves to `/job-proxy/<c>/static/...`.
 *
 * Strategy: if the HTML has an existing `<base>` tag in `<head>`, replace
 * it. Otherwise, insert a fresh one immediately after `<head>` (or at
 * the very start if there's no `<head>`). The browser uses the first
 * `<base>` it sees, so this is reliable.
 */
export function injectBaseHref(html: string, proxyPrefix: string): string {
  const baseTag = `<base href="${proxyPrefix}/">`;
  // Replace any existing <base ...> with ours.
  if (/<base\b[^>]*>/i.test(html)) {
    return html.replace(/<base\b[^>]*>/i, baseTag);
  }
  // No existing base — insert right after the opening <head>.
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}${baseTag}`);
  }
  // No <head> either (rare — service-worker shells, error pages). Inject
  // before the first tag that looks like body content.
  return baseTag + html;
}

/** Set of request headers we never forward upstream. Hop-by-hop + headers
 * undici/the WS client manage themselves. */
export const HTTP_HOP_BY_HOP = new Set([
  "host", "connection", "content-length", "accept-encoding", "upgrade",
]);

/** Set of response headers we never forward back to the browser. Strip
 * encoding/length so Next can re-frame the body for chunked/identity. */
export const HTTP_RESP_STRIP = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection",
]);

/** Hop-by-hop + WS-handshake headers that the `ws` client re-emits itself
 * on its own upgrade. Forwarding them as-is would corrupt the new
 * handshake (stale Sec-WebSocket-Key vs the freshly-generated Accept). */
export const WS_HOP_BY_HOP = new Set([
  "host", "connection", "upgrade", "content-length",
  "sec-websocket-version", "sec-websocket-key",
  "sec-websocket-extensions", "sec-websocket-accept",
]);
