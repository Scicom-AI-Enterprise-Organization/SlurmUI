"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  clusterId: string;
  /** When set, the controller hops one more ssh into this IP. */
  nodeIp?: string;
}

type Status = "connecting" | "connected" | "exited" | "error";

/**
 * xterm.js terminal pane backed by a PTY on the cluster controller (and
 * optionally hopped one ssh further into a worker node).
 *
 * Transport: SSE for PTY output, POST for keystrokes/resize. We deliberately
 * avoid WebSocket because VS Code Remote-SSH port-forwarding (a common
 * dev-time entry path) drops the Upgrade handshake.
 */
export function ClusterShellPane({ clusterId, nodeIp }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        selectionBackground: "#264f78",
      },
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    term.writeln("\x1b[36m[aura] terminal ready, requesting shell session…\x1b[0m");

    const initialFit = requestAnimationFrame(() => {
      try { fit.fit(); } catch {}
    });

    let evt: EventSource | null = null;
    let sessionId: string | null = null;
    let cancelled = false;

    const postInput = (body: object) => {
      if (!sessionId) return;
      void fetch(`/api/cluster-shell/${sessionId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    };

    const sendResize = () => {
      postInput({ type: "resize", cols: term.cols, rows: term.rows });
    };

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
      sendResize();
    });
    ro.observe(containerRef.current);

    (async () => {
      try {
        const res = await fetch(`/api/clusters/${clusterId}/shell-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nodeIp ? { nodeIp } : {}),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = await res.json();
        sessionId = data.sessionId as string;
      } catch (err) {
        if (cancelled) return;
        const m = (err as Error).message;
        setStatus("error");
        setErrorMsg(m);
        term.writeln(`\x1b[1;31m[aura] Failed to mint shell session: ${m}\x1b[0m`);
        return;
      }
      if (cancelled || !sessionId) return;

      term.writeln(`\x1b[36m[aura] opening stream…\x1b[0m`);

      evt = new EventSource(`/api/cluster-shell/${sessionId}/stream`);

      evt.onopen = () => {
        setStatus("connected");
        sendResize();
      };

      evt.onmessage = (e) => {
        let msg: { type?: string; data?: string; code?: number; message?: string };
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === "data" && typeof msg.data === "string") {
          const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
          term.write(bytes);
        } else if (msg.type === "exit") {
          term.writeln(
            `\r\n\x1b[1;31m[aura] Session ended (exit code ${msg.code ?? 0}).\x1b[0m`,
          );
          setStatus("exited");
          try { evt?.close(); } catch {}
        } else if (msg.type === "error") {
          term.writeln(`\x1b[1;31m[aura] ${msg.message ?? "Error"}\x1b[0m`);
          setStatus("error");
          setErrorMsg(msg.message ?? "Stream error");
          try { evt?.close(); } catch {}
        }
      };

      evt.onerror = () => {
        if (cancelled) return;
        setStatus((s) => {
          if (s === "exited" || s === "error") return s;
          term.writeln("\x1b[1;31m[aura] Stream connection lost.\x1b[0m");
          setErrorMsg("Stream connection lost");
          return "error";
        });
        try { evt?.close(); } catch {}
      };

      term.onData((data) => {
        const b64 = btoa(unescape(encodeURIComponent(data)));
        postInput({ type: "input", data: b64 });
      });

      term.focus();
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(initialFit);
      ro.disconnect();
      try { evt?.close(); } catch {}
      term.dispose();
    };
  }, [clusterId, nodeIp]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-[560px] w-full overflow-hidden rounded-md border border-border bg-[#0d1117]">
        <div ref={containerRef} className="h-full w-full p-2" />
      </div>
      <StatusStrip status={status} errorMsg={errorMsg} nodeIp={nodeIp} />
    </div>
  );
}

function StatusStrip({
  status,
  errorMsg,
  nodeIp,
}: {
  status: Status;
  errorMsg: string | null;
  nodeIp?: string;
}) {
  const target = nodeIp ? `node ${nodeIp}` : "controller";
  if (status === "connecting") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Allocating shell on {target}…</span>
      </div>
    );
  }
  if (status === "connected") {
    return (
      <div className="flex items-center gap-2 text-xs text-emerald-500">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
        <span>Connected to {target}</span>
      </div>
    );
  }
  if (status === "exited") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground" />
        <span>Session ended. Close and reopen the dialog to start a new shell.</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-red-500">
      <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
      <span>{errorMsg ?? "Connection error"}</span>
    </div>
  );
}
