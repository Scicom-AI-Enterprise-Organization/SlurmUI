"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Terminal, BookOpen, Loader2, ExternalLink, Trash2 } from "lucide-react";

interface AppDef {
  type: "shell" | "jupyter";
  title: string;
  description: string;
  icon: React.ReactNode;
  tags: string[];
}

const APPS: AppDef[] = [
  {
    type: "shell",
    title: "Interactive Shell",
    description: "Request an interactive Slurm allocation and drop into a bash shell on a compute node.",
    icon: <Terminal className="h-8 w-8 text-green-500" />,
    tags: ["bash", "interactive"],
  },
  {
    type: "jupyter",
    title: "Jupyter Notebook",
    description: "Start a Jupyter Notebook server on the controller node using your NFS home as the working directory.",
    icon: <BookOpen className="h-8 w-8 text-orange-500" />,
    tags: ["Python", "ML", "Data Science"],
  },
];

interface AppSession {
  id: string;
  type: string;
  partition: string;
  status: string;
  accessUrl: string | null;
  createdAt: string;
}

interface Partition { name: string }

export default function AppsPage() {
  const params = useParams();
  const router = useRouter();
  const clusterId = params.id as string;

  const [sessions, setSessions] = useState<AppSession[]>([]);
  const [partitions, setPartitions] = useState<string[]>([]);
  const [launching, setLaunching] = useState<"shell" | "jupyter" | null>(null);
  const [dialogApp, setDialogApp] = useState<AppDef | null>(null);
  const [partition, setPartition] = useState("");
  const [ntasks, setNtasks] = useState("1");
  const [timeLimit, setTimeLimit] = useState("2:00:00");

  const fetchSessions = () =>
    fetch(`/api/clusters/${clusterId}/apps`)
      .then((r) => r.json())
      .then((data) => setSessions(Array.isArray(data) ? data : []))
      .catch(() => {});

  useEffect(() => {
    fetchSessions();
    // Load partitions from cluster config via existing config endpoint
    fetch(`/api/clusters/${clusterId}/config`)
      .then((r) => r.json())
      .then((cfg: Record<string, any>) => {
        const parts = (cfg.slurm_partitions ?? []) as Partition[];
        setPartitions(parts.map((p) => p.name));
        if (parts.length > 0) setPartition(parts[0].name);
      })
      .catch(() => {});
  }, [clusterId]);

  const launchApp = async () => {
    if (!dialogApp || !partition) return;
    setLaunching(dialogApp.type);
    try {
      const res = await fetch(`/api/clusters/${clusterId}/apps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: dialogApp.type,
          partition,
          ntasks: parseInt(ntasks) || 1,
          time_limit: timeLimit || "2:00:00",
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Launch failed" }));
        throw new Error(err.error);
      }

      const session = await res.json();
      setDialogApp(null);
      toast.success(`${dialogApp.title} session started`);
      router.push(`/clusters/${clusterId}/apps/${session.id}`);
    } catch (e: any) {
      toast.error(e.message ?? "Launch failed");
    } finally {
      setLaunching(null);
    }
  };

  const killSession = async (sessionId: string) => {
    await fetch(`/api/clusters/${clusterId}/apps/${sessionId}`, { method: "DELETE" }).catch(() => {});
    fetchSessions();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Apps</h1>
        <p className="text-muted-foreground">Launch interactive applications on the cluster.</p>
      </div>

      {/* App catalog */}
      <div className="grid gap-4 md:grid-cols-2">
        {APPS.map((app) => (
          <Card key={app.type} className="flex flex-col">
            <CardHeader>
              <div className="flex items-start gap-3">
                {app.icon}
                <div>
                  <CardTitle>{app.title}</CardTitle>
                  <CardDescription className="mt-1">{app.description}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="mt-auto space-y-3">
              <div className="flex flex-wrap gap-1">
                {app.tags.map((t) => (
                  <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
                ))}
              </div>
              <Button className="w-full" onClick={() => setDialogApp(app)}>
                Launch
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Active sessions */}
      {sessions.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Active Sessions</h2>
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                  <th className="px-4 py-2 text-left font-medium">Partition</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Started</th>
                  <th className="px-4 py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="px-4 py-2 font-medium capitalize">{s.type}</td>
                    <td className="px-4 py-2">{s.partition}</td>
                    <td className="px-4 py-2">
                      <Badge variant={s.status === "RUNNING" ? "default" : "secondary"}>
                        {s.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {new Date(s.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right flex items-center justify-end gap-2">
                      {s.accessUrl && (
                        <a href={s.accessUrl} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm">
                            <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open
                          </Button>
                        </a>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => router.push(`/clusters/${clusterId}/apps/${s.id}`)}
                      >
                        Connect
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => killSession(s.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Launch dialog */}
      <Dialog open={!!dialogApp} onOpenChange={(open) => !open && setDialogApp(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Launch {dialogApp?.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Partition</Label>
              <Select value={partition} onValueChange={(v) => v && setPartition(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select partition..." />
                </SelectTrigger>
                <SelectContent>
                  {partitions.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {dialogApp?.type === "shell" && (
              <div className="space-y-1.5">
                <Label>Tasks</Label>
                <Input value={ntasks} onChange={(e) => setNtasks(e.target.value)} type="number" min={1} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Time Limit</Label>
              <Input value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)} placeholder="2:00:00" />
            </div>
            {dialogApp?.type === "jupyter" && (
              <p className="text-xs text-muted-foreground">
                Jupyter will start on the controller node. Ensure the selected port (8888–8999)
                is open in your firewall/security group.
              </p>
            )}
            <Button
              className="w-full"
              onClick={launchApp}
              disabled={!partition || !!launching}
            >
              {launching ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Launching...</> : "Launch"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
