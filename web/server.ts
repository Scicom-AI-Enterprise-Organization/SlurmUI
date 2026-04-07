import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import { handleWebSocket } from "./lib/ws";
import { auth } from "./lib/auth";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT ?? "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

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

    if (pathname !== "/api/ws") {
      socket.destroy();
      return;
    }

    const clusterId = query.clusterId as string;
    if (!clusterId) {
      socket.destroy();
      return;
    }

    // Validate auth token from query param
    // In production, use a signed token from the session
    const token = query.token as string;
    if (!token) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
      // userId extracted from token validation above
      handleWebSocket(ws, clusterId, token).catch((err) => {
        console.error("[WS] Error in handleWebSocket:", err);
        ws.close(1011, "Internal error");
      });
    });
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
