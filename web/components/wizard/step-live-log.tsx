"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";

interface StepLiveLogProps {
  clusterId: string | null;
  config: Record<string, unknown> | null;
}

interface LogLine {
  seq: number;
  text: string;
}

type Status = "waiting" | "streaming" | "complete" | "error";

export function StepLiveLog({ clusterId, config }: StepLiveLogProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<Status>("waiting");
  const [result, setResult] = useState<{ success: boolean; message?: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const router = useRouter();

  useEffect(() => {
    if (!clusterId || !config || startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/clusters/${clusterId}/bootstrap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config }),
        });

        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: "Bootstrap request failed" }));
          setLines((p) => [
            ...p,
            { seq: 0, text: `[error] ${err.error ?? "Failed to start bootstrap"}` },
          ]);
          setStatus("error");
          return;
        }

        setStatus("streaming");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "stream") {
                setLines((p) => [...p, { seq: event.seq, text: event.line }]);
              } else if (event.type === "complete") {
                setResult({ success: event.success, message: event.message });
                setStatus(event.success ? "complete" : "error");
              }
            } catch {}
          }
        }
      } catch (err) {
        if (!cancelled) {
          setLines((p) => [
            ...p,
            { seq: -1, text: `[error] ${err instanceof Error ? err.message : "Unknown error"}` },
          ]);
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clusterId, config]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const statusBadge: Record<Status, React.ReactNode> = {
    waiting: <Badge variant="outline">Waiting...</Badge>,
    streaming: <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">Running</Badge>,
    complete: <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Success</Badge>,
    error: <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">Failed</Badge>,
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Bootstrap Log</CardTitle>
        {statusBadge[status]}
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          ref={scrollRef}
          className="h-96 overflow-y-auto rounded-md border bg-black p-4 font-mono text-xs text-green-400"
        >
          {lines.length === 0 && status === "waiting" && (
            <p className="text-gray-500">Waiting for bootstrap to start...</p>
          )}
          {lines.map((line, i) => (
            <div key={`${line.seq}-${i}`} className="whitespace-pre-wrap leading-5">
              {line.text}
            </div>
          ))}
          {status === "complete" && (
            <div className="mt-4 border-t border-gray-700 pt-2 text-white">
              ✓ Bootstrap completed successfully. Cluster is now ACTIVE.
            </div>
          )}
          {status === "error" && result && (
            <div className="mt-4 border-t border-gray-700 pt-2 text-red-400">
              ✗ Bootstrap failed: {result.message ?? "Unknown error"}
            </div>
          )}
        </div>

        {status === "complete" && clusterId && (
          <Button className="w-full" onClick={() => router.push("/admin/clusters")}>
            Go to Clusters
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
