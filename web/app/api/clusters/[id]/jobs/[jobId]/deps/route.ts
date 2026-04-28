/**
 * Resolve a single job's local dependency DAG: parents (jobs this job
 * waits on) and children (jobs waiting on this job). Each node carries
 * basic Slurm state so the UI can render colored links without a
 * second round-trip per node.
 *
 *   parents   ──>  self  ──>  children
 *
 * Sources:
 *   - parents: scontrol show job -dd <self>  →  Dependency=afterok:1234,afterany:5678
 *   - children: squeue -h -o "%i|%E"          →  any line whose %E references self
 *               sacct …                        →  same idea, but for finished jobs
 *
 * We also pull state for each parent/child id in one combined sacct/squeue
 * scan so the UI can show RUNNING / COMPLETED / FAILED / etc. inline.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string; jobId: string }> }

interface DepRef {
  // Slurm job id (string for array-job tolerance, e.g. "1234_3").
  slurmJobId: string;
  type: string;          // afterok, afterany, afternotok, after, singleton, ...
  state?: string;        // RUNNING / COMPLETED / FAILED / PENDING / ...
  name?: string;
  // SlurmUI Job.id when this slurm job was submitted via SlurmUI — drives
  // deep-link rendering. null/missing = external job, render plain text.
  auraJobId?: string;
}

interface DepsResponse {
  self: { slurmJobId: string; state: string; name: string; auraJobId: string };
  parents: DepRef[];
  children: DepRef[];
  // Best-effort — true when we actually got a scontrol response.
  ok: boolean;
}

/**
 * Parse a scontrol Dependency= field into structured refs. Slurm format:
 *   Dependency=afterok:1234,afterany:5678
 *   Dependency=afterok:1234?afterany:5678        ('?'  = OR)
 *   Dependency=(null)
 * We treat `,` and `?` identically here — the DAG view just shows edges.
 */
function parseDependencyField(s: string): DepRef[] {
  if (!s || s === "(null)") return [];
  const parts = s.split(/[,?]/).map((p) => p.trim()).filter(Boolean);
  const refs: DepRef[] = [];
  for (const p of parts) {
    // afterok:1234, afterany:1234[+30], singleton (no id)
    const m = p.match(/^([a-z_]+)(?::([0-9_]+))?/i);
    if (!m) continue;
    refs.push({ type: m[1].toLowerCase(), slurmJobId: m[2] ?? "" });
  }
  return refs.filter((r) => r.slurmJobId);
}

/**
 * Parse `squeue -o "%i|%E"` lines into { id, dependency }. squeue prints
 * `(null)` when no dep; we filter those out.
 */
function parseSqueueDepLines(text: string): Array<{ slurmJobId: string; deps: DepRef[]; state: string; name: string }> {
  const out: Array<{ slurmJobId: string; deps: DepRef[]; state: string; name: string }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split("|");
    if (cols.length < 4) continue;
    const [jid, depField, state, name] = cols;
    if (!jid || depField === "(null)") continue;
    out.push({ slurmJobId: jid, deps: parseDependencyField(depField), state, name });
  }
  return out;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.clusterId !== id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if ((session.user as any).role !== "ADMIN" && job.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!job.slurmJobId) {
    return NextResponse.json({ error: "No Slurm job ID" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey || cluster.connectionMode !== "SSH") {
    return NextResponse.json({ error: "Not available for this cluster" }, { status: 412 });
  }
  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const slurmId = String(job.slurmJobId);
  // Pull self's Dependency= AND a queue-wide dump of (jobid, dependency,
  // state, name) so we can extract children in a single SSH call.
  // sacct catches finished children that already left squeue.
  const script = `#!/bin/bash
set +e
echo "__AURA_DEPS_START__"

echo "__SECTION__=self"
scontrol show job -dd ${slurmId} 2>&1

echo "__SECTION__=squeue"
squeue -h -o "%i|%E|%T|%j" 2>&1

echo "__SECTION__=sacct"
# -X = no allocations / batch sub-rows; -P = pipe-delimited; we limit by
# StartTime so big histories don't bog down the round-trip.
sacct -X -P -S now-30days --format=JobID,Dependency,State,JobName 2>&1

echo "__AURA_DEPS_END__"
`;

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });
  const full = chunks.join("\n");
  const start = full.indexOf("__AURA_DEPS_START__");
  const end = full.indexOf("__AURA_DEPS_END__");
  if (start === -1 || end === -1) {
    return NextResponse.json({ error: "deps: no response" }, { status: 502 });
  }
  const body = full.slice(start, end);
  const sectionOf = (name: string): string => {
    const re = new RegExp(`__SECTION__=${name}\\n([\\s\\S]*?)(?=\\n__SECTION__=|$)`);
    return body.match(re)?.[1].trim() ?? "";
  };
  const selfBlock = sectionOf("self");
  const squeueText = sectionOf("squeue");
  const sacctText = sectionOf("sacct");

  // --- parents ---
  const depMatch = selfBlock.match(/Dependency=([^\s]+)/);
  const parentRefs = depMatch ? parseDependencyField(depMatch[1]) : [];

  const selfState = selfBlock.match(/JobState=([A-Z_]+)/)?.[1] ?? "UNKNOWN";
  const selfName = selfBlock.match(/JobName=([^\s]+)/)?.[1] ?? "";

  // --- children: scan squeue for any job whose Dependency= contains my id ---
  const queueRows = parseSqueueDepLines(squeueText);
  const idRegex = new RegExp(`(?:^|[,:?])${slurmId}(?:[+_]|$|[,?])`);
  const childrenFromQueue: DepRef[] = queueRows
    .filter((r) => r.deps.some((d) => d.slurmJobId === slurmId || idRegex.test(":" + d.slurmJobId)))
    .map((r) => {
      // Find which dep type points at us (so we can label the edge).
      const link = r.deps.find((d) => d.slurmJobId === slurmId);
      return {
        slurmJobId: r.slurmJobId,
        type: link?.type ?? "after",
        state: r.state,
        name: r.name,
      };
    });

  // --- children: also scan sacct for finished children (sacct doesn't
  //     always include Dependency for completed jobs but newer Slurm does).
  const childrenFromSacct: DepRef[] = [];
  for (const raw of sacctText.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("JobID|")) continue;
    const cols = line.split("|");
    if (cols.length < 4) continue;
    const [sid, dep, state, name] = cols;
    if (!sid || sid === slurmId) continue;
    const refs = parseDependencyField(dep);
    const link = refs.find((d) => d.slurmJobId === slurmId);
    if (!link) continue;
    if (childrenFromQueue.some((c) => c.slurmJobId === sid)) continue;
    childrenFromSacct.push({ slurmJobId: sid, type: link.type, state, name });
  }

  // --- enrich parent refs with state from squeue/sacct (parents may be
  //     pending, running, or already finished). ---
  const stateBySlurmId = new Map<string, { state: string; name?: string }>();
  for (const r of queueRows) stateBySlurmId.set(r.slurmJobId, { state: r.state, name: r.name });
  for (const raw of sacctText.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("JobID|")) continue;
    const cols = line.split("|");
    if (cols.length < 4) continue;
    const [sid, , state, name] = cols;
    if (!sid) continue;
    if (!stateBySlurmId.has(sid)) stateBySlurmId.set(sid, { state, name });
  }
  for (const p of parentRefs) {
    const s = stateBySlurmId.get(p.slurmJobId);
    if (s) { p.state = s.state; p.name = s.name; }
  }

  // --- attach Aura Job.id where we can, so the UI can deep-link. ---
  const allSlurmIds = new Set<string>([
    ...parentRefs.map((r) => r.slurmJobId),
    ...childrenFromQueue.map((r) => r.slurmJobId),
    ...childrenFromSacct.map((r) => r.slurmJobId),
  ]);
  if (allSlurmIds.size > 0) {
    const numIds = Array.from(allSlurmIds)
      .map((s) => Number(s.split(/[+_]/)[0]))
      .filter((n) => Number.isFinite(n));
    if (numIds.length > 0) {
      const auraJobs = await prisma.job.findMany({
        where: { clusterId: id, slurmJobId: { in: numIds } },
        select: { id: true, slurmJobId: true },
      });
      const m = new Map<string, string>();
      for (const j of auraJobs) if (j.slurmJobId) m.set(String(j.slurmJobId), j.id);
      const enrich = (refs: DepRef[]) => refs.forEach((r) => {
        const auraId = m.get(r.slurmJobId.split(/[+_]/)[0]);
        if (auraId) r.auraJobId = auraId;
      });
      enrich(parentRefs);
      enrich(childrenFromQueue);
      enrich(childrenFromSacct);
    }
  }

  const response: DepsResponse = {
    self: { slurmJobId: slurmId, state: selfState, name: selfName, auraJobId: jobId },
    parents: parentRefs,
    children: [...childrenFromQueue, ...childrenFromSacct],
    ok: true,
  };
  return NextResponse.json(response);
}
