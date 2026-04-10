"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface LiveLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  clusterId: string;
  requestId: string | null;
  onSuccess?: () => void;
}

interface LogLine {
  seq: number;
  text: string;
}

type Status = "connecting" | "streaming" | "complete" | "error";

export function LiveLogDialog({
  open,
  onOpenChange,
  title,
  clusterId,
  requestId,
  onSuccess,
}: LiveLogDialogProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !requestId || startedRef.current === requestId) return;
    startedRef.current = requestId;

    setLines([]);
    setStatus("connecting");

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(
          `/api/clusters/${clusterId}/stream/${requestId}`,
          { method: "GET" }
        );

        if (!res.ok || !res.body) {
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
                setStatus(event.success ? "complete" : "error");
                if (event.success) onSuccess?.();
              }
            } catch {}
          }
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, requestId, clusterId, onSuccess]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const statusBadge: Record<Status, React.ReactNode> = {
    connecting: <Badge variant="outline">Connecting...</Badge>,
    streaming: <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">Running</Badge>,
    complete: <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Success</Badge>,
    error: <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">Failed</Badge>,
  };

  const isDone = status === "complete" || status === "error";

  return (
    <Dialog open={open} onOpenChange={isDone ? onOpenChange : undefined}>
      <DialogContent className="max-w-2xl">
        <DialogHeader className="flex flex-row items-center justify-between">
          <DialogTitle>{title}</DialogTitle>
          {statusBadge[status]}
        </DialogHeader>

        <div
          ref={scrollRef}
          className="h-80 overflow-y-auto rounded-md border bg-black p-4 font-mono text-xs text-green-400"
        >
          {lines.length === 0 && status === "connecting" && (
            <p className="text-gray-500">Waiting for agent response...</p>
          )}
          {lines.map((line, i) => (
            <div key={`${line.seq}-${i}`} className="whitespace-pre-wrap leading-5">
              {line.text}
            </div>
          ))}
        </div>

        {isDone && (
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
