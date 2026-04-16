"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Terminal, Loader2, Send } from "lucide-react";

interface TerminalButtonProps {
  clusterId: string;
}

export function TerminalButton({ clusterId }: TerminalButtonProps) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    setTimeout(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, 10);
  };

  const runCommand = async () => {
    const cmd = command.trim();
    if (!cmd || running) return;

    setCommand("");
    setLines((prev) => [...prev, `$ ${cmd}`]);
    setRunning(true);
    scrollToBottom();

    try {
      const res = await fetch(`/api/clusters/${clusterId}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setLines((prev) => [...prev, `[error] ${err.error ?? "Command failed"}`]);
        return;
      }

      const data = await res.json();
      if (data.stdout) {
        for (const line of data.stdout.split("\n")) {
          setLines((prev) => [...prev, line]);
        }
      }
      if (data.stderr) {
        for (const line of data.stderr.split("\n")) {
          if (line) setLines((prev) => [...prev, `[stderr] ${line}`]);
        }
      }
      if (!data.success) {
        setLines((prev) => [...prev, `[exit code ${data.exitCode}]`]);
      }
    } catch {
      setLines((prev) => [...prev, "[error] Request failed"]);
    } finally {
      setRunning(false);
      scrollToBottom();
      inputRef.current?.focus();
    }
  };

  const handleOpen = () => {
    setLines([`Connected to cluster controller via SSH`, ``]);
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  return (
    <>
      <Button variant="outline" onClick={handleOpen}>
        <Terminal className="mr-2 h-4 w-4" />
        Terminal
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Terminal</DialogTitle>
          </DialogHeader>

          <div
            ref={logRef}
            className="h-[500px] overflow-y-auto rounded-md border bg-black p-3 font-mono text-sm text-green-400"
          >
            {lines.map((line, i) => (
              <div
                key={i}
                className={`whitespace-pre-wrap leading-5 ${
                  line.startsWith("[stderr]") ? "text-yellow-400" :
                  line.startsWith("[error]") ? "text-red-400" :
                  line.startsWith("$") ? "text-cyan-400" : ""
                }`}
              >
                {line || "\u00A0"}
              </div>
            ))}
            {running && (
              <div className="inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runCommand(); }}
              placeholder="Type a command..."
              className="font-mono text-sm"
              disabled={running}
              autoFocus
            />
            <Button onClick={runCommand} disabled={running || !command.trim()} size="default">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
