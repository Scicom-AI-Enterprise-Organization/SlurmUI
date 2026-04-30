/**
 * End-to-end smoke test for the job proxy.
 *
 * Drives a real Aura instance with a fresh job pointing the proxy at a
 * tiny in-process HTTP+WS server we control. Exercises:
 *
 *   - HTTP forwarding (path strip + diagnostic headers + body pass-through)
 *   - HTML body rewriting
 *   - OpenAPI servers injection
 *   - Location header rewriting
 *   - Set-Cookie path rewriting
 *   - WebSocket bridging (frame in, frame out)
 *   - 1005/1006 close codes don't crash the bridge
 *
 * Because the actual proxy goes browser → Aura → SSH tunnel → controller →
 * worker, we can't just point it at our test server inside this process —
 * the SSH tunnel layer expects a remote target. So this test EITHER:
 *
 *   (a) runs against the running dev compose with a Jupyter-shaped job
 *       configured to forward to a hardcoded port. You set
 *       AURA_PROXY_CLUSTER, AURA_PROXY_JOB, AURA_SESSION_COOKIE.
 *
 *   (b) runs in MOCK mode (default): boots a tiny http+ws server on
 *       localhost and asserts the rewrite logic by hitting the upstream
 *       directly (no Aura proxy in between). This catches rewrite-helper
 *       regressions without needing a cluster.
 *
 * Run:
 *   # Mock mode (default — no cluster needed):
 *   node --import tsx --test --test-reporter=spec test/job-proxy.smoke.test.mjs
 *
 *   # Live mode (against a real running proxy):
 *   AURA_PROXY_BASE=http://localhost:3000 \
 *   AURA_PROXY_CLUSTER=<id> AURA_PROXY_JOB=<id> \
 *   AURA_SESSION_COOKIE='authjs.session-token=…' \
 *   node --import tsx --test --test-reporter=spec test/job-proxy.smoke.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const LIVE = !!(process.env.AURA_PROXY_CLUSTER && process.env.AURA_PROXY_JOB && process.env.AURA_SESSION_COOKIE);
const BASE = (process.env.AURA_PROXY_BASE ?? "http://localhost:3000").replace(/\/+$/, "");
const COOKIE = process.env.AURA_SESSION_COOKIE ?? "";
const PROXY_URL = LIVE
  ? `${BASE}/job-proxy/${process.env.AURA_PROXY_CLUSTER}/${process.env.AURA_PROXY_JOB}`
  : "";

// ---------- Fake upstream (mock mode only) ----------

let fakeServer;
let fakeWss;
let fakeOrigin = "";

before(() => {
  if (LIVE) return;
  fakeServer = createServer((req, res) => {
    if (req.url === "/openapi.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ openapi: "3.0.0", info: { title: "x" }, paths: {} }));
      return;
    }
    if (req.url === "/swagger.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ swagger: "2.0", info: { title: "x" }, paths: {} }));
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/tree" });
      res.end();
      return;
    }
    if (req.url === "/setcookie") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Set-Cookie": ["session=abc; Path=/; HttpOnly", "_xsrf=def; Path=/api"],
      });
      res.end("ok");
      return;
    }
    if (req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<a href="/login">x</a><script src="//cdn.example.com/x.js"></script>`);
      return;
    }
    if (req.url === "/echo") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello");
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found", reason: null }));
  });
  fakeWss = new WebSocketServer({ server: fakeServer });
  fakeWss.on("connection", (ws) => {
    // Echo every message back; close on client request.
    ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
  return new Promise((resolve) => {
    fakeServer.listen(0, "127.0.0.1", () => {
      const addr = fakeServer.address();
      fakeOrigin = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(() => {
  if (!LIVE && fakeServer) {
    fakeWss?.close();
    fakeServer.close();
  }
});

// ---------- Mock-mode tests: validate rewrite contract against a fake upstream ----------
//
// These don't go through the Aura proxy. They feed the same kind of
// responses the proxy receives upstream into the rewrite helpers and
// assert the output. End-to-end through a real proxy is in LIVE mode.

const mockOnly = (name, fn) => test(name, { skip: LIVE ? "live mode" : false }, fn);
const liveOnly = (name, fn) => test(name, { skip: LIVE ? false : "no AURA_PROXY_* env" }, fn);

const PREFIX = "/job-proxy/cl/job";

// Re-import the helpers under test. Live mode skips these.
let helpers = null;
before(async () => {
  helpers = await import("../lib/job-proxy-rewrite.ts");
});

mockOnly("fake upstream serves the canned routes", async () => {
  const r = await fetch(`${fakeOrigin}/echo`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "hello");
});

mockOnly("OpenAPI spec gets `servers` injected", async () => {
  const r = await fetch(`${fakeOrigin}/openapi.json`);
  const text = await r.text();
  const rewritten = helpers.injectOpenApiServers(text, PREFIX);
  const parsed = JSON.parse(rewritten);
  assert.deepEqual(parsed.servers, [{ url: PREFIX, description: "Aura job proxy" }]);
});

mockOnly("Swagger 2.0 spec gets `basePath` + `host` injected", async () => {
  const r = await fetch(`${fakeOrigin}/swagger.json`);
  const text = await r.text();
  const rewritten = helpers.injectOpenApiServers(text, PREFIX, "localhost:3000");
  const parsed = JSON.parse(rewritten);
  assert.equal(parsed.basePath, PREFIX);
  assert.equal(parsed.host, "localhost:3000");
});

mockOnly("HTML response gets quoted absolute paths rewritten", async () => {
  const r = await fetch(`${fakeOrigin}/index.html`);
  const text = await r.text();
  const out = helpers.rewriteHtmlAbsolutePaths(text, PREFIX);
  assert.match(out, new RegExp(`href="${PREFIX}/login"`));
  // Protocol-relative left alone.
  assert.match(out, /src="\/\/cdn\.example\.com/);
});

mockOnly("302 redirect Location is prefixed", async () => {
  const r = await fetch(`${fakeOrigin}/redirect`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const out = helpers.rewriteLocationHeader(r.headers.get("location"), PREFIX);
  assert.equal(out, `${PREFIX}/tree`);
});

mockOnly("Set-Cookie Path is rewritten", async () => {
  const r = await fetch(`${fakeOrigin}/setcookie`);
  const cookies = r.headers.getSetCookie?.() ?? [];
  assert.ok(cookies.length >= 2, "expected ≥2 Set-Cookie headers");
  for (const c of cookies) {
    const out = helpers.rewriteSetCookiePath(c, PREFIX);
    assert.match(out, new RegExp(`Path=${PREFIX}/`), `expected prefix in: ${out}`);
  }
});

mockOnly("WebSocket echo round-trips through the fake upstream", async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${fakeOrigin.replace("http://", "")}/ws`);
    ws.on("open", () => ws.send("ping"));
    ws.on("message", (m) => {
      assert.equal(String(m), "ping");
      ws.close(1000);
    });
    ws.on("close", () => resolve());
    ws.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 4000);
  });
});

mockOnly("safeCloseCode prevents 1005/1006 crashes when forwarding closes", () => {
  // Direct unit assertion — the LIVE bridge applies this same map.
  assert.equal(helpers.safeCloseCode(1005), 1000);
  assert.equal(helpers.safeCloseCode(1006), 1000);
});

// ---------- Live-mode tests: through the real Aura proxy ----------

liveOnly("HTTP through proxy returns upstream body and diagnostic headers", async () => {
  const r = await fetch(`${PROXY_URL}/api/contents`, { headers: { Cookie: COOKIE } });
  assert.ok(r.ok || r.status === 404, `unexpected status ${r.status}`);
  assert.ok(r.headers.get("x-aura-proxy-upstream"), "missing diagnostic header");
  // Diagnostic header should reflect the strip (no `/job-proxy/...` prefix).
  assert.doesNotMatch(r.headers.get("x-aura-proxy-upstream"), /job-proxy/);
});

liveOnly("WebSocket upgrade succeeds and bridges messages", async () => {
  // List kernels via HTTP, then connect to the first one's channel.
  const list = await fetch(`${PROXY_URL}/api/kernels`, { headers: { Cookie: COOKIE } });
  if (!list.ok) {
    assert.fail(`couldn't list kernels (HTTP ${list.status}); skip if not Jupyter`);
  }
  const kernels = await list.json();
  assert.ok(Array.isArray(kernels) && kernels.length > 0, "need ≥1 kernel — start one in Jupyter first");
  const kid = kernels[0].id;
  const wsUrl = `${PROXY_URL.replace(/^http/, "ws")}/api/kernels/${kid}/channels?session_id=test`;

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: COOKIE, Origin: BASE },
    });
    let gotMsg = false;
    ws.on("open", () => {
      ws.send(JSON.stringify({
        header: { msg_type: "kernel_info_request", msg_id: "x", session: "test", username: "t", version: "5.3" },
        parent_header: {}, metadata: {}, content: {}, channel: "shell",
      }));
    });
    ws.on("message", () => { gotMsg = true; ws.close(1000); });
    ws.on("close", () => gotMsg ? resolve() : reject(new Error("no message before close")));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS timeout")), 8000);
  });
});

liveOnly("WebSocket close with reserved code 1005 doesn't crash the bridge", async () => {
  // Open + immediately abort — `ws` library reports 1005 on no-status close.
  // Server-side this used to throw uncaughtException pre-fix.
  const list = await fetch(`${PROXY_URL}/api/kernels`, { headers: { Cookie: COOKIE } });
  if (!list.ok) return;
  const kernels = await list.json();
  if (kernels.length === 0) return;
  const kid = kernels[0].id;
  const wsUrl = `${PROXY_URL.replace(/^http/, "ws")}/api/kernels/${kid}/channels?session_id=test`;

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Cookie: COOKIE, Origin: BASE } });
    ws.on("open", () => ws.terminate()); // brutal close — no Close frame
    ws.on("close", () => resolve());
    ws.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 5000);
  });

  // If the bridge crashed, a follow-up HTTP request would 502 or hang.
  const r = await fetch(`${PROXY_URL}/api/kernels`, { headers: { Cookie: COOKIE } });
  assert.equal(r.status, 200, "proxy should still serve after abrupt WS close");
});
