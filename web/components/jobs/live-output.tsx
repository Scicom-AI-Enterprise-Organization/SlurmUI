"use client";

import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";

interface LiveOutputProps {
  clusterId: string;
  jobId: string;
  isRunning: boolean;
}

export function LiveOutput({ clusterId, jobId, isRunning }: LiveOutputProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isRunning) return;

    // Use SSE instead of WebSocket — works through any HTTP proxy without
    // special Upgrade header configuration.
    const evtSource = new EventSource(`/api/clusters/${clusterId}/stream/${jobId}`);

    setConnected(true);

    evtSource.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "stream") {
          setLines((prev) => [...prev, msg.line]);
        } else if (msg.type === "complete") {
          setConnected(false);
          evtSource.close();
        }
      } catch {}
    };

    evtSource.onerror = () => {
      setConnected(false);
      evtSource.close();
    };

    return () => evtSource.close();
  }, [clusterId, jobId, isRunning]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Output</h3>
        {isRunning && (
          <Badge variant="outline" className={connected ? "bg-green-100 text-green-800" : ""}>
            {connected ? "Live" : "Disconnected"}
          </Badge>
        )}
      </div>
      <ScrollArea className="h-96 rounded-md border bg-black p-4" ref={scrollRef}>
        <div className="font-mono text-xs text-green-400">
          {lines.length === 0 ? (
            <p className="text-gray-500">
              {isRunning ? "Waiting for output..." : "No output available"}
            </p>
          ) : (
            lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {line}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
