"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

interface StepLiveLogProps {
  requestId: string | null;
  clusterId: string | null;
}

interface LogLine {
  seq: number;
  text: string;
}

export function StepLiveLog({ requestId, clusterId }: StepLiveLogProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<"connecting" | "streaming" | "complete" | "error">(
    "connecting"
  );
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!requestId || !clusterId) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/ws?clusterId=${clusterId}&token=${requestId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("streaming");
      ws.send(JSON.stringify({ type: "subscribe", request_id: requestId }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "stream") {
        setLines((prev) => [...prev, { seq: msg.seq, text: msg.line }]);
      }

      if (msg.type === "complete") {
        setStatus("complete");
        setResult(msg.result);
      }

      if (msg.type === "error") {
        setStatus("error");
      }
    };

    ws.onerror = () => {
      setStatus("error");
    };

    ws.onclose = () => {
      if (status !== "complete") {
        setStatus("error");
      }
    };

    return () => {
      ws.close();
    };
  }, [requestId, clusterId]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const statusBadge = {
    connecting: <Badge variant="outline">Connecting...</Badge>,
    streaming: <Badge className="bg-blue-100 text-blue-800">Streaming</Badge>,
    complete: (
      <Badge className={result?.success ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
        {result?.success ? "Success" : "Failed"}
      </Badge>
    ),
    error: <Badge className="bg-red-100 text-red-800">Error</Badge>,
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Bootstrap Log</CardTitle>
        {statusBadge[status]}
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-96 rounded-md border bg-black p-4" ref={scrollRef}>
          <div className="font-mono text-xs text-green-400">
            {lines.length === 0 && status === "connecting" && (
              <p className="text-gray-500">Waiting for bootstrap to start...</p>
            )}
            {lines.map((line) => (
              <div key={line.seq} className="whitespace-pre-wrap">
                {line.text}
              </div>
            ))}
            {status === "complete" && result && (
              <div className="mt-4 border-t border-gray-700 pt-2 text-white">
                {result.success
                  ? "Bootstrap completed successfully."
                  : `Bootstrap failed: ${result.message}`}
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
