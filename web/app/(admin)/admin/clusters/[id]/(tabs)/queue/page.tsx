"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RefreshCw, Info } from "lucide-react";

type JobAction = "hold" | "release" | "requeue" | "terminate";

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
  // Map Slurm job id → SlurmUI Job.id so the queue can deep-link rows it
  // actually owns. Jobs submitted outside SlurmUI won't appear here and
  // stay as plain text.
  const [slurmMap, setSlurmMap] = useState<Record<string, string>>({});

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

  useEffect(() => {
    if (!active) return;
    fetch(`/api/clusters/${clusterId}/jobs/slurm-map`)
      .then((r) => (r.ok ? r.json() : { map: {} }))
      .then((d) => setSlurmMap(d.map ?? {}))
      .catch(() => {});
  }, [active, clusterId, rows.length]);

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
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-sm">Queue</CardTitle>
              <ActionsInfo />
            </div>
            {fetchedAt && (
              <span className="text-xs text-muted-foreground font-normal">
                {filtered.length} of {rows.length} jobs · fetched {new Date(fetchedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter by user, reason, partition..."
            className="h-8 w-full rounded-md border px-2 text-sm"
          />
          {byReason.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Pending reasons</p>
              <div className="flex flex-wrap gap-2">
                {byReason.map(([reason, count]) => (
                  <span key={reason} className="rounded-full border px-2 py-0.5 text-xs font-mono">
                    {reason} <span className="text-muted-foreground">({count})</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                {["jobid", "partition", "user", "state", "reason", "nodes", "cpus", "mem", "timeLeft", "prio", "nodelist"].map((k) => (
                  <TableHead key={k}
                    className="cursor-pointer select-none"
                    onClick={() => setSortBy(k as keyof QueueRow)}>
                    {k}{sortBy === k && " ↓"}
                  </TableHead>
                ))}
                <TableHead className="w-[200px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.jobid}>
                  <TableCell className="font-mono text-sm">
                    {slurmMap[r.jobid] ? (
                      <Link
                        href={`/clusters/${clusterId}/jobs/${slurmMap[r.jobid]}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {r.jobid}
                      </Link>
                    ) : (
                      r.jobid
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-sm">{r.partition}</TableCell>
                  <TableCell className="font-mono text-sm">{r.user}</TableCell>
                  <TableCell className="font-mono text-sm">{r.state}</TableCell>
                  <TableCell className="font-mono text-sm">{r.reason}</TableCell>
                  <TableCell className="font-mono text-sm">{r.nodes}</TableCell>
                  <TableCell className="font-mono text-sm">{r.cpus}</TableCell>
                  <TableCell className="font-mono text-sm">{r.mem}</TableCell>
                  <TableCell className="font-mono text-sm">{r.timeLeft}</TableCell>
                  <TableCell className="font-mono text-sm">{r.prio}</TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">{r.nodelist}</TableCell>
                  <TableCell>
                    <JobActions clusterId={clusterId} row={r} onDone={load} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ActionsInfo() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="inline-flex items-center text-muted-foreground hover:text-foreground"
        aria-label="hold / release / requeue explained"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 top-full z-50 mt-1 w-72 max-w-[min(18rem,calc(100vw-1rem))] whitespace-normal break-words rounded-md border bg-popover p-3 text-xs leading-relaxed shadow-md font-normal normal-case text-popover-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-2 font-medium">What these do</p>
            <ul className="space-y-2 list-none pl-0">
              <li><code className="font-mono font-semibold">hold</code> — set a <b>PENDING</b> job&apos;s priority to 0 so the scheduler ignores it. Stays queued until released.</li>
              <li><code className="font-mono font-semibold">release</code> — undo a hold; job goes back to normal priority.</li>
              <li><code className="font-mono font-semibold">requeue</code> — kill a <b>RUNNING</b> job and put it back in the queue from the start. Needs <code className="font-mono">--requeue</code> or a requeueable partition.</li>
              <li><code className="font-mono font-semibold">terminate</code> — run <code className="font-mono">scancel</code>. Ends the job immediately; cannot be resumed. Confirms first.</li>
            </ul>
          </div>
        </>
      )}
    </span>
  );
}

function JobActions({ clusterId, row, onDone }: { clusterId: string; row: QueueRow; onDone: () => void }) {
  const [busy, setBusy] = useState<JobAction | null>(null);
  const [result, setResult] = useState<{
    action: JobAction;
    ok: boolean;
    output: string;
  } | null>(null);
  const [confirmTerminate, setConfirmTerminate] = useState(false);

  const run = async (action: JobAction) => {
    setBusy(action);
    try {
      const { output } = await controlJob(clusterId, row.jobid, action);
      setResult({ action, ok: true, output: output || `${action} ${row.jobid}: ok` });
      onDone();
    } catch (e) {
      setResult({
        action,
        ok: false,
        output: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };
  const running = row.state === "RUNNING";
  const pending = row.state === "PENDING";
  const terminable = running || pending;
  return (
    <>
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
        <Button size="sm" variant="destructive" className="h-6 px-2 text-[11px]"
          disabled={!!busy || !terminable} onClick={() => setConfirmTerminate(true)}>
          {busy === "terminate" ? "..." : "terminate"}
        </Button>
      </div>
      <Dialog open={confirmTerminate} onOpenChange={setConfirmTerminate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Terminate job {row.jobid}?</DialogTitle>
            <DialogDescription>
              Runs <code>scancel {row.jobid}</code> on the controller. The job is killed immediately and cannot be resumed. Any partial output written so far stays on disk.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTerminate(false)}>Keep running</Button>
            <Button variant="destructive" onClick={() => { setConfirmTerminate(false); run("terminate"); }}>
              Terminate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!result} onOpenChange={(o) => { if (!o) setResult(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className={result?.ok ? "" : "text-destructive"}>
              {result?.ok
                ? `${result.action} job ${row.jobid}`
                : `${result?.action} failed`}
            </DialogTitle>
            <DialogDescription>
              {result?.ok
                ? `Slurm accepted the ${result.action} request.`
                : `Slurm rejected the ${result?.action} request.`}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {result?.output}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResult(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
      <Table>
        <TableHeader>
          <TableRow>
            {["partition", "avail", "timelimit", "nodes", "state", "nodelist"].map((k) => (
              <TableHead key={k}>{k}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {r.map((c, j) => <TableCell key={j} className="font-mono text-sm">{c}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
