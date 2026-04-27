"use client";

import { useRef, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, FileText, Loader2, RefreshCw } from "lucide-react";

interface LogsButtonProps {
  clusterId: string;
}

const LOG_SOURCES = [
  { value: "slurmctld", label: "Slurm Controller (slurmctld)" },
  { value: "slurmd", label: "Slurm Worker (slurmd)" },
  { value: "munge", label: "Munge" },
  { value: "aura-agent", label: "SlurmUI Agent" },
  { value: "system", label: "System (dmesg)" },
];

export function LogsButton({ clusterId }: LogsButtonProps) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("slurmctld");
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async (logSource?: string) => {
    const src = logSource ?? source;
    setLoading(true);
    setLines([]);
    setError("");

    try {
      const cmd = src === "system"
        ? "dmesg --time-format iso | tail -100"
        : `journalctl -u ${src} --no-pager -n 100 --output short-iso 2>/dev/null || echo 'Service ${src} not found'`;

      const res = await fetch(`/api/clusters/${clusterId}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setError(err.error ?? "Failed to fetch logs");
        return;
      }

      const data = await res.json();
      const output = (data.stdout || "").trim();
      if (output) {
        setLines(output.split("\n"));
      } else {
        setLines(["(no logs found)"]);
      }
      if (data.stderr?.trim()) {
        setLines((prev) => [...prev, "", ...data.stderr.trim().split("\n").map((l: string) => `[stderr] ${l}`)]);
      }
    } catch {
      setError("Request failed");
    } finally {
      setLoading(false);
      setTimeout(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      }, 10);
    }
  };

  const openWithSource = (v: string) => {
    setSource(v);
    setOpen(true);
    fetchLogs(v);
  };

  const activeLabel = LOG_SOURCES.find((s) => s.value === source)?.label ?? source;

  return (
    <>
      <DropdownMenu>
        {/* shadcn <Button> isn't forwardRef-aware so Radix's asChild Slot
            can't attach the click handler — use a plain styled <button>. */}
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            <FileText className="mr-2 h-4 w-4" />
            Logs
            <ChevronDown className="ml-2 h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {LOG_SOURCES.map((s) => (
            <DropdownMenuItem key={s.value} onClick={() => openWithSource(s.value)}>
              {s.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Cluster Logs — {activeLabel}</DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => fetchLogs()} disabled={loading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {loading && <Badge variant="outline">Loading...</Badge>}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div
            ref={logRef}
            className="h-[500px] overflow-y-auto rounded-md border bg-black p-3 font-mono text-sm text-green-400"
          >
            {loading && lines.length === 0 && (
              <div className="inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Fetching logs...
              </div>
            )}
            {lines.map((line, i) => (
              <div
                key={i}
                className={`whitespace-pre-wrap leading-5 ${
                  line.startsWith("[stderr]") ? "text-yellow-400" :
                  line.includes("error") || line.includes("ERROR") || line.includes("fatal") ? "text-red-400" :
                  line.includes("warning") || line.includes("WARN") ? "text-yellow-400" : ""
                }`}
              >
                {line || "\u00A0"}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
