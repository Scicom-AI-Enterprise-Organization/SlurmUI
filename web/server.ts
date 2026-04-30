// Must run BEFORE any module that pulls in next/next-auth internals.
// `node-environment` polyfills `globalThis.AsyncLocalStorage` from
// node:async_hooks; without it, importing `./lib/auth` (→ next-auth →
// Next App Router internals) trips the "AsyncLocalStorage accessed in
// runtime where it is not available" invariant under `tsx server.ts`.
// `next dev` does this implicitly inside its CLI; the custom server has
// to bootstrap it itself.
//
// `.js` extension is required because the prod bundle is loaded as ESM
// by plain `node`, which (unlike tsx) uses strict file resolution. The
// tsx-driven dev path tolerates the extension just fine.
import "next/dist/server/node-environment.js";

import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import { handleWebSocket } from "./lib/ws";
import { auth } from "./lib/auth";
import { startHeartbeatMonitor } from "./lib/heartbeat";
import { startHealthMonitor } from "./lib/health-monitor";
import { startGitopsJobsMonitor } from "./lib/gitops-jobs";
import { tryHandleJobProxyUpgrade } from "./lib/job-proxy-ws";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT ?? "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Suppress Next's lazy upgrade-handler registration. Inside getRequestHandler
// Next calls setupWebSocketHandler on the first HTTP request, which adds
// `customServer.on("upgrade", this.upgradeHandler)` on our server. That
// auto-handler is what crashes with `Cannot read properties of undefined
// (reading 'bind')` for any non-HMR upgrade — and worse, it destroys the
// socket, killing our /job-proxy/* WS handshake before it completes.
//
// We pre-set the flag so Next never auto-registers, then we route HMR
// upgrades to `app.upgradeHandler` ourselves below.
(app as unknown as { didWebSocketSetup: boolean }).didWebSocketSetup = true;

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error handling request:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    const { pathname, query } = parse(request.url!, true);

    // Per-job HTTP+WS reverse proxy. tryHandleJobProxyUpgrade returns true
    // when it claimed the connection (matched URL pattern), regardless of
    // success — auth/upstream errors are written to the client socket.
    if (pathname && pathname.startsWith("/job-proxy/")) {
      try {
        const handled = await tryHandleJobProxyUpgrade(request, socket, head);
        if (handled) return;
      } catch (err) {
        console.error("[job-proxy WS] handler error:", err);
        socket.destroy();
        return;
      }
    }

    if (pathname === "/api/ws") {
      const clusterId = query.clusterId as string;
      if (!clusterId) { socket.destroy(); return; }
      const token = query.token as string;
      if (!token) { socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
        handleWebSocket(ws, clusterId, token).catch((err) => {
          console.error("[WS] Error in handleWebSocket:", err);
          ws.close(1011, "Internal error");
        });
      });
      return;
    }

    // Everything else (Next HMR `/_next/webpack-hmr`, etc.) — delegate to
    // Next's upgrade handler so dev hot-reload still works.
    const nextUpgrade = (app as unknown as {
      upgradeHandler?: (...args: unknown[]) => unknown;
    }).upgradeHandler;
    if (typeof nextUpgrade === "function") {
      try { await nextUpgrade(request, socket, head); } catch { socket.destroy(); }
      return;
    }
    socket.destroy();
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });

  startHeartbeatMonitor().catch((err) => {
    console.error("[Heartbeat] Failed to start monitor:", err);
  });
  startHealthMonitor();
  startGitopsJobsMonitor();
});
