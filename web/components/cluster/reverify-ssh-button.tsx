"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, Check, X } from "lucide-react";

interface ReverifySshButtonProps {
  clusterId: string;
}

export function ReverifySshButton({ clusterId }: ReverifySshButtonProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "failed">("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");

  const runVerify = async () => {
    setStatus("testing");
    setLines([]);
    setErrorMsg("");

    try {
      const res = await fetch(`/api/clusters/${clusterId}/verify-ssh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        setStatus("failed");
        setErrorMsg(err.error ?? "Failed to verify SSH");
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
            } else if (event.type === "complete") {
              if (event.success) {
                setStatus("ok");
              } else {
                setStatus("failed");
                setErrorMsg(event.message ?? "Verification failed");
              }
              return;
            }
          } catch {}
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        buffer += "\n\n";
        const parts = buffer.split("\n\n");
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "complete") {
              if (event.success) {
                setStatus("ok");
              } else {
                setStatus("failed");
                setErrorMsg(event.message ?? "Verification failed");
              }
              return;
            }
          } catch {}
        }
      }
    } catch (err) {
      setStatus("failed");
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleOpen = () => {
    setStatus("idle");
    setLines([]);
    setErrorMsg("");
    setOpen(true);
  };

  return (
    <>
      <Button variant="outline" onClick={handleOpen}>
        <RefreshCw className="mr-2 h-4 w-4" />
        Re-verify SSH
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {status === "testing" && <Loader2 className="h-4 w-4 animate-spin" />}
              {status === "ok" && <Check className="h-4 w-4 text-green-600" />}
              {status === "failed" && <X className="h-4 w-4 text-destructive" />}
              {status === "idle" ? "Re-verify SSH Connection" :
               status === "testing" ? "Verifying..." :
               status === "ok" ? "SSH Verified" : "Verification Failed"}
            </DialogTitle>
          </DialogHeader>

          {status === "idle" ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                This will SSH into the controller node, gather system info, and check Slurm status.
                If successful, the cluster status will be updated to ACTIVE.
              </p>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button onClick={runVerify}>Run Verification</Button>
              </DialogFooter>
            </div>
          ) : (
            <>
              <div className="h-72 overflow-y-auto rounded-md border bg-black p-3 font-mono text-xs text-green-400">
                {lines.map((line, i) => (
                  <div key={i} className={line.startsWith("[stderr]") ? "text-yellow-400" : ""}>
                    {line || "\u00A0"}
                  </div>
                ))}
                {status === "testing" && (
                  <div className="mt-1 text-muted-foreground animate-pulse">Verifying...</div>
                )}
              </div>

              {status === "ok" && (
                <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 w-fit">
                  Connection OK — cluster is ACTIVE
                </Badge>
              )}
              {status === "failed" && errorMsg && (
                <p className="text-sm text-destructive">{errorMsg}</p>
              )}

              <DialogFooter>
                {status === "failed" && (
                  <Button variant="outline" onClick={runVerify}>Retry</Button>
                )}
                <DialogClose asChild>
                  <Button variant={status === "ok" ? "default" : "outline"}>
                    {status === "ok" ? "Done" : "Close"}
                  </Button>
                </DialogClose>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
