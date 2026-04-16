"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

interface StepInstallProps {
  clusterId: string | null;
  connectionMode: "NATS" | "SSH";
  sshUser: string;
  sshPort: string;
  natsUrl: string;
}

type DeployState = "idle" | "deploying" | "waiting-heartbeat" | "connected" | "failed";

export function StepInstall({ clusterId, connectionMode, sshUser, sshPort, natsUrl }: StepInstallProps) {
  const [state, setState] = useState<DeployState>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const startedRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const addLine = (line: string) => {
    setLines((prev) => [...prev, line]);
  };

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  // Parse SSE stream helper
  async function readSSE(
    res: Response,
    handlers: {
      onStream?: (line: string) => void;
      onDeployed?: () => void;
      onConnected?: () => void;
      onComplete?: (success: boolean, message?: string) => void;
      onTimeout?: () => void;
      onError?: (message: string) => void;
    },
    cancelledRef: { current: boolean },
  ) {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const processBuffer = () => {
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "stream") handlers.onStream?.(event.line);
          else if (event.type === "deployed") handlers.onDeployed?.();
          else if (event.type === "connected") handlers.onConnected?.();
          else if (event.type === "timeout") handlers.onTimeout?.();
          else if (event.type === "error") handlers.onError?.(event.message ?? "Unknown error");
          else if (event.type === "complete") handlers.onComplete?.(event.success, event.message);
        } catch {}
      }
    };

    while (!cancelledRef.current) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      processBuffer();
    }

    // Process any remaining data in buffer after stream ends
    if (buffer.trim()) {
      buffer += "\n\n";
      processBuffer();
    }
  }

  useEffect(() => {
    if (!clusterId || startedRef.current) return;
    startedRef.current = true;
    setState("deploying");

    const cancelledRef = { current: false };

    if (connectionMode === "SSH") {
      // SSH mode: SSH was already tested in step 1, just activate the cluster
      (async () => {
        try {
          addLine("[aura] SSH connectivity already verified in previous step");
          addLine("[aura] Activating cluster...");

          const res = await fetch(`/api/clusters/${clusterId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "ACTIVE" }),
          });

          if (res.ok) {
            addLine("[aura] Cluster is now ACTIVE");
            setState("connected");
          } else {
            const err = await res.json().catch(() => ({ error: "Unknown error" }));
            setState("failed");
            setErrorMsg(err.error ?? "Failed to activate cluster");
          }
        } catch (err) {
          if (!cancelledRef.current) {
            setState("failed");
            setErrorMsg(err instanceof Error ? err.message : "Unknown error");
          }
        }
      })();
    } else {
      // NATS mode: deploy agent then wait for heartbeat
      (async () => {
        try {
          // Phase 1: Deploy agent via SSH
          const deployRes = await fetch(`/api/clusters/${clusterId}/deploy-agent`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sshUser: sshUser || "root",
              sshPort: sshPort || "22",
              natsUrl,
            }),
          });

          if (!deployRes.ok || !deployRes.body) {
            const err = await deployRes.json().catch(() => ({ error: "Unknown error" }));
            setState("failed");
            setErrorMsg(err.error ?? "Failed to start deployment");
            return;
          }

          let deployed = false;

          await readSSE(deployRes, {
            onStream: addLine,
            onDeployed: () => { deployed = true; },
            onComplete: (success, message) => {
              if (!success) {
                setState("failed");
                setErrorMsg(message ?? "Deployment failed");
              }
            },
          }, cancelledRef);

          if (cancelledRef.current || !deployed) {
            if (!deployed && state !== "failed") {
              setState("failed");
              setErrorMsg("Deployment stream ended unexpectedly");
            }
            return;
          }

          // Phase 2: Wait for heartbeat
          setState("waiting-heartbeat");
          addLine("");
          addLine("[aura] Waiting for agent heartbeat...");

          const hbRes = await fetch(`/api/clusters/${clusterId}/heartbeat/stream`);
          if (!hbRes.ok || !hbRes.body) {
            setState("failed");
            setErrorMsg("Failed to open heartbeat stream");
            return;
          }

          await readSSE(hbRes, {
            onConnected: () => {
              addLine("[aura] Agent connected!");
              setState("connected");
            },
            onTimeout: () => {
              setState("failed");
              setErrorMsg("Timed out waiting for agent heartbeat");
            },
            onError: (msg) => {
              setState("failed");
              setErrorMsg(msg);
            },
          }, cancelledRef);
        } catch (err) {
          if (!cancelledRef.current) {
            setState("failed");
            setErrorMsg(err instanceof Error ? err.message : "Unknown error");
          }
        }
      })();
    }

    return () => { cancelledRef.current = true; };
  }, [clusterId, connectionMode, sshUser, sshPort, natsUrl]);

  return (
    <div className="space-y-4">
      {/* Log output */}
      <div
        ref={logRef}
        className="h-80 overflow-y-auto rounded-md border bg-black p-3 font-mono text-xs text-green-400"
      >
        {lines.length === 0 && state === "idle" && (
          <span className="text-muted-foreground">Waiting to start...</span>
        )}
        {lines.map((line, i) => (
          <div key={i} className={line.startsWith("[stderr]") ? "text-yellow-400" : ""}>
            {line || "\u00A0"}
          </div>
        ))}
        {(state === "deploying" || state === "waiting-heartbeat") && (
          <div className="inline-flex items-center gap-2 text-muted-foreground mt-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {state === "deploying"
              ? (connectionMode === "SSH" ? "Verifying SSH..." : "Deploying...")
              : "Waiting for heartbeat..."}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3">
        {state === "connected" && (
          <>
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              {connectionMode === "SSH" ? "SSH verified" : "Agent connected"}
            </Badge>
            <Button onClick={() => router.push(`/admin/clusters/${clusterId}`)}>
              Continue to cluster setup
            </Button>
          </>
        )}
        {state === "failed" && (
          <Badge variant="destructive">Error: {errorMsg}</Badge>
        )}
      </div>
    </div>
  );
}
