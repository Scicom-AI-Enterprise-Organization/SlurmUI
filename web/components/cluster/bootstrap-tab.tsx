"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Play, RotateCcw } from "lucide-react";

interface BootstrapTabProps {
  clusterId: string;
  clusterName: string;
  clusterStatus: string;
}

type Status = "idle" | "running" | "success" | "failed";

export function BootstrapTab({ clusterId, clusterName, clusterStatus }: BootstrapTabProps) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  };

  const runBootstrap = async () => {
    setStatus("running");
    setLines([]);
    setErrorMsg("");

    try {
      const res = await fetch(`/api/clusters/${clusterId}/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        setStatus("failed");
        setErrorMsg(err.error ?? "Failed to start bootstrap");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
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
              setLines((prev) => [...prev, event.line]);
              setTimeout(scrollToBottom, 10);
            } else if (event.type === "complete") {
              if (event.success) {
                setStatus("success");
                router.refresh();
              } else {
                setStatus("failed");
                setErrorMsg(event.message ?? "Bootstrap failed");
              }
              return;
            }
          } catch {}
        }
      }

      // Flush remaining
      if (buffer.trim()) {
        buffer += "\n\n";
        const parts = buffer.split("\n\n");
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "complete") {
              setStatus(event.success ? "success" : "failed");
              if (!event.success) setErrorMsg(event.message ?? "Bootstrap failed");
              if (event.success) router.refresh();
            }
          } catch {}
        }
      }
    } catch (err) {
      setStatus("failed");
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Cluster Bootstrap</CardTitle>
          {clusterStatus === "ACTIVE" && (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              Bootstrapped
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === "idle" && (
          <>
            <p className="text-sm text-muted-foreground">
              Bootstrap runs Ansible against the controller node to set up:
            </p>
            <ul className="text-sm text-muted-foreground list-disc ml-5 space-y-1">
              <li>Slurm controller (slurmctld) and munge authentication</li>
              <li>NFS server for shared storage</li>
              <li>SSSD for user/group lookups</li>
              <li>Chrony for time synchronization</li>
              <li>Common packages and configuration</li>
            </ul>
            {clusterStatus === "ACTIVE" && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                This cluster is already ACTIVE. Re-running bootstrap will re-apply the configuration.
              </p>
            )}
            <Button onClick={runBootstrap}>
              <Play className="mr-2 h-4 w-4" />
              {clusterStatus === "ACTIVE" ? "Re-run Bootstrap" : "Run Bootstrap"}
            </Button>
          </>
        )}

        {status !== "idle" && (
          <>
            <div
              ref={logRef}
              className="h-96 overflow-y-auto rounded-md border bg-black p-3 font-mono text-xs text-green-400"
            >
              {lines.map((line, i) => (
                <div
                  key={i}
                  className={`whitespace-pre-wrap leading-5 ${line.startsWith("[stderr]") ? "text-yellow-400" : ""}`}
                >
                  {line || "\u00A0"}
                </div>
              ))}
              {status === "running" && (
                <div className="mt-1 inline-flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Running Ansible...
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {status === "success" && (
                <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                  Bootstrap complete — cluster is ACTIVE
                </Badge>
              )}
              {status === "failed" && (
                <>
                  <Badge variant="destructive">Failed</Badge>
                  <span className="text-sm text-destructive">{errorMsg}</span>
                </>
              )}
              {(status === "success" || status === "failed") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setStatus("idle"); setLines([]); setErrorMsg(""); }}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {status === "failed" ? "Retry" : "Done"}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
