"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Loader2 } from "lucide-react";

interface Props {
  clusterId: string;
  sessionId: string;
}

export default function TerminalView({ clusterId, sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const evtRef = useRef<EventSource | null>(null);
  const inputBufRef = useRef("");
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const [exited, setExited] = useState(false);

  // Flush buffered keystrokes to the server (batched for performance)
  const flushInput = async (buf: string) => {
    if (!buf) return;
    const data = btoa(buf); // base64
    await fetch(`/api/clusters/${clusterId}/apps/${sessionId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    }).catch(() => {});
  };

  const sendResize = (cols: number, rows: number) => {
    fetch(`/api/clusters/${clusterId}/apps/${sessionId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cols, rows }),
    }).catch(() => {});
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize xterm.js
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 14,
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        selectionBackground: "#264f78",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Resize observer — tell the agent when the terminal is resized
    const ro = new ResizeObserver(() => {
      fit.fit();
      sendResize(term.cols, term.rows);
    });
    ro.observe(containerRef.current);

    // Keyboard input — batch keystrokes every 20ms
    term.onData((data) => {
      inputBufRef.current += data;
      if (!inputTimerRef.current) {
        inputTimerRef.current = setTimeout(() => {
          flushInput(inputBufRef.current);
          inputBufRef.current = "";
          inputTimerRef.current = null;
        }, 20);
      }
    });

    // Connect SSE for terminal output
    const evtSource = new EventSource(`/api/clusters/${clusterId}/apps/${sessionId}/stream`);
    evtRef.current = evtSource;

    evtSource.onopen = () => {
      setConnected(true);
      term.writeln("\x1b[1;32m[aura] Connected to session.\x1b[0m");
      sendResize(term.cols, term.rows);
    };

    evtSource.onmessage = (e) => {
      const evt = JSON.parse(e.data);
      if (evt.type === "pty") {
        // Raw PTY bytes (base64-encoded)
        const bytes = Uint8Array.from(atob(evt.data), (c) => c.charCodeAt(0));
        term.write(bytes);
      } else if (evt.type === "log") {
        term.writeln("\x1b[33m" + evt.line + "\x1b[0m");
      } else if (evt.type === "exit") {
        term.writeln(`\x1b[1;31m\r\n[aura] Session ended (exit code ${evt.exit_code}).\x1b[0m`);
        setExited(true);
        evtSource.close();
      }
    };

    evtSource.onerror = () => {
      if (!exited) {
        term.writeln("\x1b[1;31m[aura] Connection lost.\x1b[0m");
        setConnected(false);
      }
      evtSource.close();
    };

    return () => {
      evtSource.close();
      ro.disconnect();
      term.dispose();
      if (inputTimerRef.current) clearTimeout(inputTimerRef.current);
    };
  }, [clusterId, sessionId]);

  return (
    <div className="relative flex-1 min-h-0 rounded-lg overflow-hidden border border-border bg-[#0d1117]">
      {!connected && !exited && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d1117]/80 z-10">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Waiting for shell allocation...</span>
          </div>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full p-1" />
    </div>
  );
}
