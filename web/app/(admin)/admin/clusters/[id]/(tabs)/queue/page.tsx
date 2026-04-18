"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

type JobAction = "hold" | "release" | "requeue";

async function controlJob(clusterId: string, slurmJobId: string, action: JobAction) {
  const res = await fetch(`/api/clusters/${clusterId}/slurm-control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slurmJobId, action }),
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.output || `HTTP ${res.status}`);
  }
  return data as { output: string };
}

type Kind =
  | "queue" | "sprio" | "sinfo-reasons" | "sinfo-partitions"
  | "sdiag" | "sshare" | "qos";

async function run(clusterId: string, kind: Kind) {
  const res = await fetch(`/api/clusters/${clusterId}/slurm-diag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json() as Promise<{ output: string; fetchedAt: string }>;
}

interface QueueRow {
  jobid: string; partition: string; user: string; state: string;
  reason: string; start: string; timeLeft: string; nodes: string;
  cpus: string; mem: string; prio: string; submit: string; nodelist: string;
}

export default function QueuePage() {
  const params = useParams();
  const clusterId = params.id as string;
  const [tab, setTab] = useState("queue");

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="priority">Priority</TabsTrigger>
          <TabsTrigger value="reasons">Down Nodes</TabsTrigger>
          <TabsTrigger value="partitions">Partitions</TabsTrigger>
          <TabsTrigger value="fairshare">Fairshare</TabsTrigger>
          <TabsTrigger value="qos">QOS</TabsTrigger>
          <TabsTrigger value="sdiag">Scheduler</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-4">
          <QueueTable clusterId={clusterId} active={tab === "queue"} />
        </TabsContent>
        <TabsContent value="priority" className="mt-4">
          <Raw clusterId={clusterId} kind="sprio" active={tab === "priority"}
            help="Priority breakdown per pending job: Age, Fairshare, JobSize, Partition, QOS." />
        </TabsContent>
        <TabsContent value="reasons" className="mt-4">
          <Raw clusterId={clusterId} kind="sinfo-reasons" active={tab === "reasons"}
            help="Nodes in down/drain state and the reason logged by sinfo -R." />
        </TabsContent>
        <TabsContent value="partitions" className="mt-4">
          <PartitionTable clusterId={clusterId} active={tab === "partitions"} />
        </TabsContent>
        <TabsContent value="fairshare" className="mt-4">
          <Raw clusterId={clusterId} kind="sshare" active={tab === "fairshare"}
            help="Account/user fairshare snapshot (sshare -a)." />
        </TabsContent>
        <TabsContent value="qos" className="mt-4">
          <Raw clusterId={clusterId} kind="qos" active={tab === "qos"}
            help="QOS limits: MaxJobsPU, MaxTRESPU, MaxWall, etc." />
        </TabsContent>
        <TabsContent value="sdiag" className="mt-4">
          <Raw clusterId={clusterId} kind="sdiag" active={tab === "sdiag"}
            help="slurmctld scheduler stats: cycles, RPC queue, backfill performance." />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function QueueTable({ clusterId, active }: { clusterId: string; active: boolean }) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState<keyof QueueRow>("state");

  const load = async () => {
    setLoading(true);
    try {
      const d = await run(clusterId, "queue");
      const parsed: QueueRow[] = d.output.split("\n").map((line) => {
        const p = line.split("|");
        if (p.length < 13) return null;
        return {
          jobid: p[0], partition: p[1], user: p[2], state: p[3], reason: p[4],
          start: p[5], timeLeft: p[6], nodes: p[7], cpus: p[8], mem: p[9],
          prio: p[10], submit: p[11], nodelist: p[12],
        };
      }).filter((x): x is QueueRow => x !== null);
      setRows(parsed);
      setFetchedAt(d.fetchedAt);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (active) load(); }, [active]);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    const out = q ? rows.filter((r) =>
      r.jobid.includes(q) || r.user.toLowerCase().includes(q) ||
      r.reason.toLowerCase().includes(q) || r.partition.toLowerCase().includes(q) ||
      r.state.toLowerCase().includes(q)
    ) : rows;
    return [...out].sort((a, b) => String(a[sortBy]).localeCompare(String(b[sortBy])));
  }, [rows, filter, sortBy]);

  const byReason = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows.filter((x) => x.state === "PENDING")) {
      m.set(r.reason, (m.get(r.reason) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by user, reason, partition..."
          className="h-8 flex-1 rounded-md border px-2 text-sm"
        />
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {byReason.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Pending reasons</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {byReason.map(([reason, count]) => (
              <span key={reason} className="rounded-full border px-2 py-0.5 text-xs font-mono">
                {reason} <span className="text-muted-foreground">({count})</span>
              </span>
            ))}
          </CardContent>
        </Card>
      )}

      {err && <p className="text-sm text-destructive">{err}</p>}
      {fetchedAt && (
        <p className="text-xs text-muted-foreground">
          {filtered.length} of {rows.length} jobs · fetched {new Date(fetchedAt).toLocaleTimeString()}
        </p>
      )}

      <div className="overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              {["jobid", "partition", "user", "state", "reason", "nodes", "cpus", "mem", "timeLeft", "prio", "nodelist"].map((k) => (
                <th key={k} className="cursor-pointer px-2 py-1.5 text-left font-medium"
                  onClick={() => setSortBy(k as keyof QueueRow)}>
                  {k}{sortBy === k && " ↓"}
                </th>
              ))}
              <th className="px-2 py-1.5 text-left font-medium">actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.jobid} className="border-t font-mono">
                <td className="px-2 py-1">{r.jobid}</td>
                <td className="px-2 py-1">{r.partition}</td>
                <td className="px-2 py-1">{r.user}</td>
                <td className="px-2 py-1">{r.state}</td>
                <td className="px-2 py-1">{r.reason}</td>
                <td className="px-2 py-1">{r.nodes}</td>
                <td className="px-2 py-1">{r.cpus}</td>
                <td className="px-2 py-1">{r.mem}</td>
                <td className="px-2 py-1">{r.timeLeft}</td>
                <td className="px-2 py-1">{r.prio}</td>
                <td className="px-2 py-1 text-muted-foreground">{r.nodelist}</td>
                <td className="px-2 py-1">
                  <JobActions clusterId={clusterId} row={r} onDone={load} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function JobActions({ clusterId, row, onDone }: { clusterId: string; row: QueueRow; onDone: () => void }) {
  const [busy, setBusy] = useState<JobAction | null>(null);
  const run = async (action: JobAction) => {
    setBusy(action);
    try {
      const { output } = await controlJob(clusterId, row.jobid, action);
      toast.success(`${action} ${row.jobid}`, { description: output });
      onDone();
    } catch (e) {
      toast.error(`${action} ${row.jobid} failed`, { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const running = row.state === "RUNNING";
  const pending = row.state === "PENDING";
  return (
    <div className="flex gap-1">
      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
        disabled={!!busy || !pending} onClick={() => run("hold")}>
        {busy === "hold" ? "..." : "hold"}
      </Button>
      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
        disabled={!!busy || !pending} onClick={() => run("release")}>
        {busy === "release" ? "..." : "release"}
      </Button>
      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
        disabled={!!busy || !running} onClick={() => run("requeue")}>
        {busy === "requeue" ? "..." : "requeue"}
      </Button>
    </div>
  );
}

function PartitionTable({ clusterId, active }: { clusterId: string; active: boolean }) {
  const [rows, setRows] = useState<string[][]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const d = await run(clusterId, "sinfo-partitions");
      setRows(d.output.split("\n").filter(Boolean).map((l) => l.split("|")));
    } finally { setLoading(false); }
  };

  useEffect(() => { if (active) load(); }, [active]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      <div className="overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>{["partition", "avail", "timelimit", "nodes", "state", "nodelist"].map((k) => (
              <th key={k} className="px-2 py-1.5 text-left font-medium">{k}</th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t font-mono">
                {r.map((c, j) => <td key={j} className="px-2 py-1">{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Raw({ clusterId, kind, help, active }: { clusterId: string; kind: Kind; help: string; active: boolean }) {
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const d = await run(clusterId, kind);
      setOutput(d.output);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (active) load(); }, [active]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{help}</p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="max-h-[500px] overflow-auto rounded-md border bg-black p-3">
        <pre className="font-mono text-xs text-green-400 whitespace-pre">{output || "(empty)"}</pre>
      </div>
    </div>
  );
}
