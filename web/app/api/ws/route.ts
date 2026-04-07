import { NextRequest, NextResponse } from "next/server";

// WebSocket upgrades cannot be handled by Next.js API routes directly.
// The actual WebSocket server runs on the same port via custom server setup.
// This route serves as documentation and health check.
export async function GET(req: NextRequest) {
  const upgradeHeader = req.headers.get("upgrade");

  if (upgradeHeader === "websocket") {
    // In production, this is intercepted by the custom server before reaching Next.js
    return new NextResponse("WebSocket upgrade must be handled by custom server", {
      status: 426,
    });
  }

  return NextResponse.json({
    status: "ok",
    message: "WebSocket endpoint. Connect via ws:// protocol.",
    protocol: {
      subscribe: { type: "subscribe", request_id: "uuid" },
      stream: { type: "stream", request_id: "uuid", line: "...", seq: 1 },
      complete: { type: "complete", request_id: "uuid", result: {} },
    },
  });
}
