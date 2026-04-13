"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check, Copy, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

interface StepInstallProps {
  clusterId: string | null;
}

type ConnState = "waiting" | "connecting" | "connected" | "timeout" | "error";
type TokenState = "valid" | "used" | "expired" | "loading";

export function StepInstall({ clusterId }: StepInstallProps) {
  const [connState, setConnState] = useState<ConnState>("waiting");
  const [copied, setCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const startedRef = useRef(false);
  const router = useRouter();

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  // Fetch the actual token from the cluster record to build real URL
  const [installCmd, setInstallCmd] = useState<string | null>(null);
  const [tokenState, setTokenState] = useState<TokenState>("loading");

  useEffect(() => {
    if (!clusterId) return;
    fetch(`/api/clusters/${clusterId}`)
      .then((r) => r.json())
      .then((c) => {
        if (c.installToken) {
          const now = new Date();
          if (c.installTokenUsedAt) {
            setTokenState("used");
            setInstallCmd(null);
          } else if (c.installTokenExpiresAt && new Date(c.installTokenExpiresAt) < now) {
            setTokenState("expired");
            setInstallCmd(null);
          } else {
            setTokenState("valid");
            setInstallCmd(`curl -fsSL ${baseUrl}/api/install/${c.installToken} | bash`);
          }
        }
      })
      .catch(() => {});
  }, [clusterId, baseUrl]);

  useEffect(() => {
    if (!clusterId || startedRef.current) return;
    startedRef.current = true;
    setConnState("connecting");

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/clusters/${clusterId}/heartbeat/stream`);
        if (!res.ok || !res.body) {
          setConnState("error");
          setErrorMsg("Failed to open heartbeat stream");
          return;
        }

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
              if (event.type === "connected") {
                setConnState("connected");
                return;
              } else if (event.type === "timeout") {
                setConnState("timeout");
                return;
              } else if (event.type === "error") {
                setConnState("error");
                setErrorMsg(event.message ?? "Unknown error");
                return;
              }
            } catch {}
          }
        }
      } catch (err) {
        if (!cancelled) {
          setConnState("error");
          setErrorMsg(err instanceof Error ? err.message : "Unknown error");
        }
      }
    })();

    return () => { cancelled = true; };
  }, [clusterId]);

  const copyCmd = () => {
    if (!installCmd) return;
    navigator.clipboard.writeText(installCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Run the following command on your master node as <strong>root</strong>. It will download
          the agent binary, configure it with this cluster&apos;s ID, and start it as a systemd
          service.
        </p>
      </div>

      <Card>
        <CardContent className="pt-4">
          {(tokenState === "used" || tokenState === "expired") ? (
            <div className="rounded-md bg-yellow-50 border border-yellow-200 p-3 text-sm text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200">
              {tokenState === "used"
                ? "This install token has already been used."
                : "This install token has expired."}
              {" "}Go to the cluster detail page to regenerate it.
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <code className="flex-1 rounded bg-muted px-3 py-2 font-mono text-sm break-all">
                {installCmd ?? "Loading..."}
              </code>
              <Button variant="outline" size="sm" onClick={copyCmd} disabled={!installCmd}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        {connState === "connecting" && (
          <>
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Waiting for agent to connect...</span>
          </>
        )}
        {connState === "connected" && (
          <>
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              Agent connected
            </Badge>
            <Button onClick={() => router.push(`/admin/clusters/${clusterId}`)}>
              Continue to cluster setup →
            </Button>
          </>
        )}
        {connState === "timeout" && (
          <Badge variant="outline" className="text-yellow-700">
            Timed out — regenerate the install command from the cluster page and try again
          </Badge>
        )}
        {connState === "error" && (
          <Badge variant="destructive">Error: {errorMsg}</Badge>
        )}
      </div>
    </div>
  );
}
