"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";

interface LiveOutputProps {
  clusterId: string;
  jobId: string;
  isRunning: boolean;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function LiveOutput({ clusterId, jobId, isRunning }: LiveOutputProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [earlier, setEarlier] = useState<string>("");
  const [fileSize, setFileSize] = useState<number>(0);
  const [pollStatus, setPollStatus] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  // Per-tick timings from the /output poll: latest response's `debug` array
  // plus the client-side round-trip. Shown in a collapsible panel below
  // the log so the user can see where each refresh is spending its time.
  const [pollDebug, setPollDebug] = useState<Array<{ stage: string; ms: number }>>([]);
  const [pollDebugOpen, setPollDebugOpen] = useState(false);
  const [pollFetchMs, setPollFetchMs] = useState<number | null>(null);
  const [pollHistory, setPollHistory] = useState<Array<{ at: number; totalMs: number; size: number }>>([]);
  // Cap the *rendered* length. Rendering huge <pre> blocks tanks the browser
  // (each re-render re-lays-out the full string), so we keep a max of the
  // tail. 0 = no cap.
  const [maxDisplay, setMaxDisplay] = useState<number>(10 * 1024);
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

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, earlier, autoScroll, maxDisplay]);

  // Poll the on-disk file and auto-backfill anything the SSE stream hasn't
  // surfaced. The watcher that feeds `Job.output` (and thus the SSE stream)
  // can drop its SSH session mid-job; when that happens the live panel would
  // silently stop updating. Reading the file directly every few seconds keeps
  // the UI honest.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const t0 = Date.now();
      try {
        const r = await fetch(
          `/api/clusters/${clusterId}/jobs/${jobId}/output?offset=0&limit=52428800`,
        );
        if (!r.ok) {
          setPollStatus(`poll HTTP ${r.status}`);
          return;
        }
        const d = await r.json();
        if (cancelled) return;
        const size = Number(d.size ?? 0);
        const disk: string = d.output ?? "";
        const elapsed = Date.now() - t0;
        setFileSize(size);
        setPollStatus(`poll ok: source=${d.source} size=${size} returned=${disk.length} in ${elapsed}ms`);
        setEarlier((prev) => (disk.length <= prev.length ? prev : disk));
        if (Array.isArray(d.debug)) setPollDebug(d.debug);
        setPollFetchMs(elapsed);
        // Keep a rolling history of the last 10 polls so the user can see
        // whether each refresh is getting slower/faster over time.
        setPollHistory((prev) => {
          const next = [...prev, { at: Date.now(), totalMs: elapsed, size }];
          return next.length > 10 ? next.slice(next.length - 10) : next;
        });
      } catch (e) {
        setPollStatus(`poll err: ${e instanceof Error ? e.message : "unknown"}`);
      }
    };
    poll();
    if (!isRunning) return;
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [clusterId, jobId, isRunning]);

  const sseText = lines.join("\n");
  // Prefer whichever is longer: the disk snapshot (refreshed every 5s by the
  // poller) or the SSE stream. Avoids double-rendering lines that show up in
  // both, and keeps the panel fresh even when the backend watcher's SSH tail
  // has died.
  const fullText = earlier.length >= sseText.length ? earlier : sseText;
  const truncated = maxDisplay > 0 && fullText.length > maxDisplay;
  const displayText = truncated ? fullText.slice(fullText.length - maxDisplay) : fullText;
  const shown = fullText.length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Output</h3>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {fileSize > 0 ? `${fmtBytes(shown)} of ${fmtBytes(fileSize)}` : "— "}
            {` · rendering ${fmtBytes(displayText.length)} (cap ${maxDisplay === 0 ? "∞" : fmtBytes(maxDisplay)})`}
            {pollStatus && ` · ${pollStatus}`}
          </span>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Tail</span>
            <select
              value={String(maxDisplay)}
              onChange={(e) => setMaxDisplay(Number(e.target.value))}
              className="h-7 rounded-md border bg-background px-2 text-xs"
            >
              <option value="10240">10 KB</option>
              <option value="25600">25 KB</option>
              <option value="51200">50 KB</option>
              <option value="0">Full</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            <span>Auto-scroll</span>
          </label>
          {isRunning && (
            <Badge variant="outline" className={connected ? "bg-green-100 text-green-800" : ""}>
              {connected ? "Live" : "Disconnected"}
            </Badge>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="h-96 overflow-auto rounded-md border bg-black p-4"
      >
        <div className="font-mono text-xs text-green-400">
          {displayText ? (
            <>
              {truncated && (
                <p className="mb-2 text-gray-500">
                  … showing last {fmtBytes(maxDisplay)} of {fmtBytes(fullText.length)} …
                </p>
              )}
              <pre className="whitespace-pre-wrap">{displayText}</pre>
            </>
          ) : (
            <p className="text-gray-500">
              {isRunning ? "Waiting for output..." : "No output available"}
            </p>
          )}
        </div>
      </div>

      {(pollDebug.length > 0 || pollFetchMs !== null) && (
        <div className="rounded-md border bg-muted/40 text-xs">
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-2 text-left font-mono hover:bg-muted"
            onClick={() => setPollDebugOpen((o) => !o)}
          >
            <span>
              <span className="mr-2 text-muted-foreground">{pollDebugOpen ? "▾" : "▸"}</span>
              debug
              {pollFetchMs !== null && (
                <span className="ml-2 text-muted-foreground">
                  (last poll {pollFetchMs} ms
                  {pollDebug.length > 0 ? `, ${pollDebug.length} stages` : ""}
                  {pollHistory.length > 1 ? `, ${pollHistory.length} polls` : ""})
                </span>
              )}
            </span>
          </button>
          {pollDebugOpen && (
            <div className="space-y-2 border-t px-3 py-2 font-mono">
              {pollDebug.length > 0 && (
                <div>
                  <div className="mb-1 text-muted-foreground">last poll — per-stage</div>
                  <div className="space-y-1">
                    {pollDebug.map((m, i) => {
                      const prev = i === 0 ? 0 : pollDebug[i - 1].ms;
                      const delta = m.ms - prev;
                      return (
                        <div key={i} className="flex gap-3">
                          <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                            +{m.ms}ms
                          </span>
                          <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                            Δ{delta}ms
                          </span>
                          <span className="text-foreground/80">{m.stage}</span>
                        </div>
                      );
                    })}
                    {pollFetchMs !== null && (
                      <div className="flex gap-3 border-t pt-1 text-muted-foreground">
                        <span className="w-14 shrink-0 text-right tabular-nums">
                          {pollFetchMs}ms
                        </span>
                        <span>client round-trip (network + handler)</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {pollHistory.length > 1 && (
                <div>
                  <div className="mb-1 text-muted-foreground">rolling history (last {pollHistory.length} polls)</div>
                  <div className="space-y-0.5">
                    {pollHistory.map((h, i) => (
                      <div key={h.at} className="flex gap-3 text-muted-foreground">
                        <span className="w-14 shrink-0 text-right tabular-nums">
                          #{pollHistory.length - i}
                        </span>
                        <span className="w-20 shrink-0 text-right tabular-nums">
                          {h.totalMs}ms
                        </span>
                        <span className="w-20 shrink-0 text-right tabular-nums">
                          {fmtBytes(h.size)}
                        </span>
                        <span>{new Date(h.at).toLocaleTimeString()}</span>
                      </div>
                    )).reverse()}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
