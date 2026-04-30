/**
 * Pure-logic unit tests for lib/job-proxy-rewrite.ts.
 *
 * No network, no Prisma, no SSH. Every helper here is referentially
 * transparent — these tests just lock down their input → output contract
 * so a future regex tweak can't silently change behaviour.
 *
 * Run with:
 *   node --test --test-reporter=spec web/test/job-proxy-rewrite.unit.test.mjs
 *
 * Note: tsx is required so the .ts file resolves under node:test. If
 * `tsx` isn't installed globally, `npm exec` from the web/ directory works.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  JOB_PROXY_RE,
  HTTP_HOP_BY_HOP,
  HTTP_RESP_STRIP,
  WS_HOP_BY_HOP,
  injectBaseHref,
  injectOpenApiServers,
  parseCookies,
  rewriteHtmlAbsolutePaths,
  rewriteLocationHeader,
  rewriteSetCookiePath,
  safeCloseCode,
  stripProxyPrefix,
} = await import("../lib/job-proxy-rewrite.ts");

const PREFIX = "/job-proxy/cl-1/job-1";

// ---------- JOB_PROXY_RE ----------

test("JOB_PROXY_RE matches /job-proxy/<cluster>/<job>", () => {
  assert.match("/job-proxy/cl-1/job-1", JOB_PROXY_RE);
  assert.match("/job-proxy/cl-1/job-1/", JOB_PROXY_RE);
  assert.match("/job-proxy/cl-1/job-1/api/contents", JOB_PROXY_RE);
  const m = "/job-proxy/cl-abc/job-xyz/foo/bar".match(JOB_PROXY_RE);
  assert.equal(m[1], "cl-abc");
  assert.equal(m[2], "job-xyz");
});

test("JOB_PROXY_RE rejects partial / non-proxy paths", () => {
  assert.doesNotMatch("/job-proxy/", JOB_PROXY_RE);
  assert.doesNotMatch("/job-proxy/cl-only", JOB_PROXY_RE);
  assert.doesNotMatch("/api/contents", JOB_PROXY_RE);
  assert.doesNotMatch("/_next/webpack-hmr", JOB_PROXY_RE);
});

// ---------- stripProxyPrefix ----------

test("stripProxyPrefix removes the prefix from a pathname", () => {
  assert.equal(stripProxyPrefix(`${PREFIX}/api/contents`, PREFIX), "/api/contents");
  assert.equal(stripProxyPrefix(`${PREFIX}/`, PREFIX), "/");
  assert.equal(stripProxyPrefix(PREFIX, PREFIX), "/");
});

test("stripProxyPrefix is no-op for paths missing the prefix", () => {
  assert.equal(stripProxyPrefix("/api/contents", PREFIX), "/api/contents");
  assert.equal(stripProxyPrefix("/", PREFIX), "/");
});

test("stripProxyPrefix always returns a leading slash", () => {
  // Edge case: weird slice math could drop the leading slash.
  const long = `${PREFIX}/foo/bar`;
  const out = stripProxyPrefix(long, PREFIX);
  assert.ok(out.startsWith("/"), `expected leading slash, got ${out}`);
});

// ---------- safeCloseCode ----------

test("safeCloseCode maps 1005/1006 to 1000", () => {
  assert.equal(safeCloseCode(1005), 1000);
  assert.equal(safeCloseCode(1006), 1000);
});

test("safeCloseCode passes through other codes", () => {
  for (const c of [1000, 1001, 1011, 4000, 4999]) {
    assert.equal(safeCloseCode(c), c);
  }
});

// ---------- parseCookies ----------

test("parseCookies handles a typical Cookie header", () => {
  const got = parseCookies("a=1; b=hello; c=foo%20bar");
  assert.deepEqual(got, { a: "1", b: "hello", c: "foo bar" });
});

test("parseCookies returns {} on missing/empty header", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
});

test("parseCookies skips malformed pairs", () => {
  // Bare names, leading-equals entries, and empty segments shouldn't crash.
  const got = parseCookies("ok=1; =skipme; alsoskip; another=2");
  assert.deepEqual(got, { ok: "1", another: "2" });
});

// ---------- rewriteHtmlAbsolutePaths ----------

test("rewriteHtmlAbsolutePaths prefixes quoted absolute paths", () => {
  const html = `<a href="/login">x</a> <script src='/static/foo.js'></script>`;
  const out = rewriteHtmlAbsolutePaths(html, PREFIX);
  assert.match(out, new RegExp(`href="${PREFIX}/login"`));
  assert.match(out, new RegExp(`src='${PREFIX}/static/foo.js'`));
});

test("rewriteHtmlAbsolutePaths leaves protocol-relative URLs alone", () => {
  const html = `<script src="//cdn.example.com/foo.js"></script>`;
  assert.equal(rewriteHtmlAbsolutePaths(html, PREFIX), html);
});

test("rewriteHtmlAbsolutePaths is idempotent on already-prefixed paths", () => {
  const html = `<a href="${PREFIX}/api/contents">x</a>`;
  assert.equal(rewriteHtmlAbsolutePaths(html, PREFIX), html);
});

test("rewriteHtmlAbsolutePaths handles Swagger UI's openapi.json reference", () => {
  // Real-world FastAPI Swagger HTML embeds this exact string.
  const html = `const ui = SwaggerUIBundle({ url: '/openapi.json' });`;
  const out = rewriteHtmlAbsolutePaths(html, PREFIX);
  assert.match(out, new RegExp(`url: '${PREFIX}/openapi.json'`));
});

test("rewriteHtmlAbsolutePaths leaves full URLs alone", () => {
  const html = `<a href="https://example.com/login">`;
  assert.equal(rewriteHtmlAbsolutePaths(html, PREFIX), html);
});

test("rewriteHtmlAbsolutePaths rewrites <script src=> AND inline body", () => {
  // We rewrite both the attribute on the opening tag AND quoted absolute
  // paths inside the body. Jupyter's `requirejs.config({baseUrl: "/static"})`
  // requires this — the route handler strips upstream CSP so the
  // inline-script-hash concern that previously kept us out of bodies is
  // moot. See the function doc for why this changed.
  const html = `<script src="/static/foo.js"></script><script nonce="x">requirejs.config({baseUrl:"/static/"})</script>`;
  const out = rewriteHtmlAbsolutePaths(html, PREFIX);
  assert.match(out, new RegExp(`src="${PREFIX}/static/foo.js"`));
  assert.match(out, new RegExp(`baseUrl:"${PREFIX}/static/"`));
});

test("rewriteHtmlAbsolutePaths rewrites <style> body url() too", () => {
  const html = `<style>.a{background:url("/img.png")}</style>`;
  const out = rewriteHtmlAbsolutePaths(html, PREFIX);
  assert.match(out, new RegExp(`url\\("${PREFIX}/img.png"\\)`));
});

// ---------- injectBaseHref ----------

test("injectBaseHref inserts a fresh <base> after <head> when none exists", () => {
  const html = `<html><head><title>x</title></head><body>y</body></html>`;
  const out = injectBaseHref(html, PREFIX);
  assert.match(out, new RegExp(`<head><base href="${PREFIX}/"><title>`));
});

test("injectBaseHref replaces an existing <base>", () => {
  const html = `<head><base href="/old/"><title>x</title></head>`;
  const out = injectBaseHref(html, PREFIX);
  assert.match(out, new RegExp(`<base href="${PREFIX}/">`));
  assert.doesNotMatch(out, /<base href="\/old\/">/);
});

test("injectBaseHref handles HTML without <head>", () => {
  const html = `<!doctype html><body>x</body>`;
  const out = injectBaseHref(html, PREFIX);
  assert.ok(out.startsWith(`<base href="${PREFIX}/">`), "should prepend <base> when no <head>");
});

test("injectBaseHref preserves <head> attributes when inserting", () => {
  const html = `<head data-x="1"><title>x</title></head>`;
  const out = injectBaseHref(html, PREFIX);
  assert.match(out, new RegExp(`<head data-x="1"><base href="${PREFIX}/">`));
});

// ---------- injectOpenApiServers ----------

test("injectOpenApiServers sets `servers` for OpenAPI 3.x", () => {
  const spec = JSON.stringify({ openapi: "3.0.0", info: { title: "x" }, paths: {} });
  const out = injectOpenApiServers(spec, PREFIX);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.servers, [{ url: PREFIX, description: "Aura job proxy" }]);
});

test("injectOpenApiServers sets `basePath` + `host` for Swagger 2.0", () => {
  const spec = JSON.stringify({ swagger: "2.0", info: { title: "x" }, paths: {} });
  const out = injectOpenApiServers(spec, PREFIX, "localhost:3000");
  const parsed = JSON.parse(out);
  assert.equal(parsed.basePath, PREFIX);
  assert.equal(parsed.host, "localhost:3000");
});

test("injectOpenApiServers returns null for non-OpenAPI JSON", () => {
  assert.equal(injectOpenApiServers(JSON.stringify({ random: "json" }), PREFIX), null);
  assert.equal(injectOpenApiServers(JSON.stringify([1, 2, 3]), PREFIX), null);
});

test("injectOpenApiServers returns null on invalid JSON", () => {
  assert.equal(injectOpenApiServers("not json {{{", PREFIX), null);
});

// ---------- rewriteLocationHeader ----------

test("rewriteLocationHeader prefixes bare absolute paths", () => {
  assert.equal(rewriteLocationHeader("/tree", PREFIX), `${PREFIX}/tree`);
  assert.equal(rewriteLocationHeader("/", PREFIX), `${PREFIX}/`);
});

test("rewriteLocationHeader leaves protocol-relative / full URLs alone", () => {
  assert.equal(rewriteLocationHeader("//cdn.example.com", PREFIX), null);
  assert.equal(rewriteLocationHeader("https://example.com/foo", PREFIX), null);
});

test("rewriteLocationHeader is idempotent", () => {
  assert.equal(rewriteLocationHeader(`${PREFIX}/already`, PREFIX), null);
  assert.equal(rewriteLocationHeader(PREFIX, PREFIX), null);
});

test("rewriteLocationHeader handles null/empty input", () => {
  assert.equal(rewriteLocationHeader(null, PREFIX), null);
  assert.equal(rewriteLocationHeader("", PREFIX), null);
});

// ---------- rewriteSetCookiePath ----------

test("rewriteSetCookiePath rewrites Path=/specific/sub", () => {
  const c = "_xsrf=abc; Path=/api; HttpOnly";
  const out = rewriteSetCookiePath(c, PREFIX);
  assert.match(out, new RegExp(`Path=${PREFIX}/api`));
  assert.match(out, /_xsrf=abc/);
  assert.match(out, /HttpOnly/);
});

test("rewriteSetCookiePath rewrites Path=/", () => {
  const c = "_xsrf=abc; Path=/; HttpOnly";
  const out = rewriteSetCookiePath(c, PREFIX);
  assert.match(out, new RegExp(`Path=${PREFIX}/`));
});

test("rewriteSetCookiePath is idempotent", () => {
  const c = `_xsrf=abc; Path=${PREFIX}/api; HttpOnly`;
  assert.equal(rewriteSetCookiePath(c, PREFIX), c);
});

test("rewriteSetCookiePath leaves Path-less cookies alone", () => {
  const c = "_xsrf=abc; HttpOnly";
  assert.equal(rewriteSetCookiePath(c, PREFIX), c);
});

// ---------- HTTP_HOP_BY_HOP / HTTP_RESP_STRIP / WS_HOP_BY_HOP ----------

test("hop-by-hop sets contain the expected request headers", () => {
  for (const h of ["host", "connection", "content-length", "accept-encoding", "upgrade"]) {
    assert.ok(HTTP_HOP_BY_HOP.has(h), `HTTP_HOP_BY_HOP missing ${h}`);
  }
});

test("WS_HOP_BY_HOP includes the WS-handshake headers", () => {
  for (const h of ["host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version"]) {
    assert.ok(WS_HOP_BY_HOP.has(h), `WS_HOP_BY_HOP missing ${h}`);
  }
});

test("HTTP_RESP_STRIP includes encoding/length so Next can re-frame", () => {
  for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection"]) {
    assert.ok(HTTP_RESP_STRIP.has(h), `HTTP_RESP_STRIP missing ${h}`);
  }
});
