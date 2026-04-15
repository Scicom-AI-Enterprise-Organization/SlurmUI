"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, Package, X, CheckCircle2, XCircle } from "lucide-react";

interface PackagesTabProps {
  clusterId: string;
}

type InstallState = "idle" | "running" | "success" | "error";

export function PackagesTab({ clusterId }: PackagesTabProps) {
  const [input, setInput] = useState("");
  const [packages, setPackages] = useState<string[]>([]);
  const [state, setState] = useState<InstallState>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const evtRef = useRef<EventSource | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [logs]);

  // Clean up SSE on unmount
  useEffect(() => () => evtRef.current?.close(), []);

  const addPackage = () => {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed || packages.includes(trimmed)) return;
    setPackages((p) => [...p, trimmed]);
    setInput("");
  };

  const removePackage = (pkg: string) => setPackages((p) => p.filter((x) => x !== pkg));

  const install = async () => {
    if (packages.length === 0) return;
    setState("running");
    setLogs([]);
    setError(null);

    const res = await fetch(`/api/clusters/${clusterId}/packages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packages }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Request failed" }));
      setError(data.error ?? "Request failed");
      setState("error");
      return;
    }

    const { request_id } = await res.json();
    const evtSource = new EventSource(`/api/clusters/${clusterId}/stream/${request_id}`);
    evtRef.current = evtSource;

    evtSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "stream") {
          setLogs((prev) => [...prev, event.line]);
        } else if (event.type === "complete") {
          evtSource.close();
          if (event.success) {
            setState("success");
            toast.success(`Installed: ${packages.join(", ")}`);
            setPackages([]);
          } else {
            setError(event.payload?.error ?? "Installation failed");
            setState("error");
          }
        }
      } catch {}
    };

    evtSource.onerror = () => {
      evtSource.close();
      setError("Connection lost — agent may be offline.");
      setState("error");
    };
  };

  const reset = () => {
    setState("idle");
    setLogs([]);
    setError(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Install Packages</h2>
        <p className="text-sm text-muted-foreground">
          Packages are installed via <code>apt</code> on the controller and all worker nodes simultaneously.
        </p>
      </div>

      {(state === "idle" || state === "success") && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="e.g. htop, nvtop, python3-scipy"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPackage()}
              className="max-w-sm"
              />
            <Button variant="outline" onClick={addPackage} disabled={!input.trim()}>
              Add
            </Button>
          </div>

          {packages.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {packages.map((pkg) => (
                <Badge key={pkg} variant="secondary" className="gap-1 pr-1">
                  <Package className="h-3 w-3" />
                  {pkg}
                  <button
                    onClick={() => removePackage(pkg)}
                    className="ml-1 rounded hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          <Button
            onClick={install}
            disabled={packages.length === 0}
          >
            Install on all nodes
          </Button>
        </div>
      )}

      {(state === "running" || state === "success" || state === "error") && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            {state === "running" && <Loader2 className="h-4 w-4 animate-spin" />}
            {state === "success" && <CheckCircle2 className="h-4 w-4 text-green-500" />}
            {state === "error" && <XCircle className="h-4 w-4 text-destructive" />}
            {state === "running" ? "Installing..." : state === "success" ? "Installation complete" : "Installation failed"}
          </div>

          <div
            ref={logRef}
            className="h-64 overflow-y-auto rounded-md border bg-black p-3 font-mono text-xs text-green-400"
          >
            {logs.length === 0 && <span className="text-gray-500">Starting...</span>}
            {logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap leading-5">{l}</div>
            ))}
            {state === "running" && (
              <div className="mt-1 text-yellow-400 animate-pulse">⠋ running...</div>
            )}
          </div>

          {state === "error" && error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {(state === "success" || state === "error") && (
            <Button variant="outline" onClick={reset}>
              Install more packages
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
