"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileText, Loader2, RefreshCw } from "lucide-react";

interface LogsButtonProps {
  clusterId: string;
}

const LOG_SOURCES = [
  { value: "slurmctld", label: "Slurm Controller (slurmctld)" },
  { value: "slurmd", label: "Slurm Worker (slurmd)" },
  { value: "munge", label: "Munge" },
  { value: "aura-agent", label: "Aura Agent" },
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

  const handleOpen = () => {
    setOpen(true);
    fetchLogs();
  };

  const handleSourceChange = (v: string) => {
    setSource(v);
    fetchLogs(v);
  };

  return (
    <>
      <Button variant="outline" onClick={handleOpen}>
        <FileText className="mr-2 h-4 w-4" />
        Logs
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton className="max-w-[90vw]">
          <DialogHeader>
            <DialogTitle>Cluster Logs</DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-3">
            <Select value={source} onValueChange={handleSourceChange}>
              <SelectTrigger className="w-[280px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_SOURCES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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
