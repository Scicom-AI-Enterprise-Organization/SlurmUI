import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";
import { logAudit } from "@/lib/audit";

interface RouteParams { params: Promise<{ id: string }> }

interface Reservation {
  name: string;
  startTime: string;
  endTime: string;
  duration: string;
  nodes: string;
  nodeCount: string;
  users: string;
  accounts: string;
  partition: string;
  flags: string;
  state: string;
  tres: string;
}

// Admin-only guard shared by both routes.
async function requireAdmin() {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session };
}

async function runOnController(clusterId: string, script: string): Promise<string> {
  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey || cluster.connectionMode !== "SSH") {
    throw Object.assign(new Error("Not available for this cluster"), { status: 412 });
  }
  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };
  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });
  return chunks.join("\n");
}

// Parses `scontrol show reservation` text format. Slurm emits one record per
// blank-line-separated block, each block is space-separated `Key=Value` pairs
// (with values that may contain commas but not spaces).
function parseReservations(text: string): Reservation[] {
  const out: Reservation[] = [];
  const blocks = text.split(/\n\s*\n+/);
  for (const block of blocks) {
    if (!block.includes("ReservationName=")) continue;
    const kv: Record<string, string> = {};
    for (const tok of block.split(/\s+/)) {
      const m = tok.match(/^([A-Za-z]+)=(.*)$/);
      if (m) kv[m[1]] = m[2];
    }
    if (!kv.ReservationName) continue;
    out.push({
      name: kv.ReservationName,
      startTime: kv.StartTime ?? "",
      endTime: kv.EndTime ?? "",
      duration: kv.Duration ?? "",
      nodes: kv.Nodes ?? "",
      nodeCount: kv.NodeCnt ?? "",
      users: kv.Users ?? "",
      accounts: kv.Accounts ?? "",
      partition: kv.PartitionName ?? "",
      flags: kv.Flags ?? "",
      state: kv.State ?? "",
      tres: kv.TRES ?? "",
    });
  }
  return out;
}

// GET /api/clusters/[id]/reservations
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  try {
    const marker = `__RES_${Date.now()}__`;
    const out = await runOnController(id, `#!/bin/bash\nset +e\necho "${marker}_START"\nscontrol show reservation 2>&1\necho "${marker}_END"\n`);
    const s = out.indexOf(`${marker}_START`);
    const e = out.indexOf(`${marker}_END`);
    const body = s !== -1 && e !== -1 ? out.slice(s + marker.length + 6, e).trim() : "";
    const lower = body.toLowerCase();
    if (lower.includes("no reservations in the system")) {
      return NextResponse.json({ reservations: [] });
    }
    return NextResponse.json({ reservations: parseReservations(body), raw: body });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}

function shellEscape(s: string): string {
  if (/^[A-Za-z0-9_,:\-\/=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// POST /api/clusters/[id]/reservations — create a reservation.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const body = (await req.json()) as {
    name?: string;
    startTime?: string;
    duration?: string;
    endTime?: string;
    nodes?: string;
    nodeCount?: string;
    users?: string;
    accounts?: string;
    partition?: string;
    flags?: string;
  };

  const name = (body.name ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return NextResponse.json({ error: "Invalid reservation name (A-Z, 0-9, _, -)" }, { status: 400 });
  }
  if (!body.startTime) {
    return NextResponse.json({ error: "startTime required (e.g. now, 2026-05-01T10:00)" }, { status: 400 });
  }
  if (!body.duration && !body.endTime) {
    return NextResponse.json({ error: "Either duration or endTime required" }, { status: 400 });
  }
  if (!body.nodes && !body.nodeCount) {
    return NextResponse.json({ error: "Either nodes or nodeCount required" }, { status: 400 });
  }
  if (!body.users && !body.accounts) {
    return NextResponse.json({ error: "Either users or accounts required" }, { status: 400 });
  }

  const parts: string[] = [`ReservationName=${shellEscape(name)}`];
  parts.push(`StartTime=${shellEscape(body.startTime)}`);
  if (body.duration) parts.push(`Duration=${shellEscape(body.duration)}`);
  if (body.endTime) parts.push(`EndTime=${shellEscape(body.endTime)}`);
  if (body.nodes) parts.push(`Nodes=${shellEscape(body.nodes)}`);
  if (body.nodeCount) parts.push(`NodeCnt=${shellEscape(body.nodeCount)}`);
  if (body.users) parts.push(`Users=${shellEscape(body.users)}`);
  if (body.accounts) parts.push(`Accounts=${shellEscape(body.accounts)}`);
  if (body.partition) parts.push(`PartitionName=${shellEscape(body.partition)}`);
  if (body.flags) parts.push(`Flags=${shellEscape(body.flags)}`);

  const marker = `__RES_CREATE_${Date.now()}__`;
  const script = `#!/bin/bash
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"
echo "${marker}_START"
$S scontrol create reservation ${parts.join(" ")} 2>&1
ec=$?
echo "${marker}_END:$ec"
`;

  try {
    const out = await runOnController(id, script);
    const s = out.indexOf(`${marker}_START`);
    const endMatch = out.match(new RegExp(`${marker}_END:(\\d+)`));
    const exit = endMatch ? parseInt(endMatch[1], 10) : null;
    const eIdx = endMatch ? out.indexOf(endMatch[0]) : -1;
    const resp = s !== -1 && eIdx !== -1
      ? out.slice(s + marker.length + 6, eIdx).trim()
      : out.trim();

    await logAudit({
      action: "reservation.create",
      entity: "Cluster",
      entityId: id,
      metadata: { name, success: exit === 0 },
    });

    if (exit !== 0) {
      return NextResponse.json({ error: resp || "scontrol failed", exitCode: exit }, { status: 400 });
    }
    return NextResponse.json({ created: name, output: resp });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}
