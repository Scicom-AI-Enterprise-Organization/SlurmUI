import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";
import { logAudit } from "@/lib/audit";
import { QOS_FIELDS, type QosField } from "@/lib/qos-fields";

interface RouteParams { params: Promise<{ id: string }> }

interface QosRow {
  name: string;
  priority: string;
  maxJobsPU: string;
  maxSubmitPU: string;
  maxWall: string;
  maxTRESPU: string;
  maxTRESPJ: string;
  grpTRES: string;
  grpJobs: string;
  flags: string;
}

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

// GET /api/clusters/[id]/qos
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const marker = `__QOS_${Date.now()}__`;
  const format = "Name,Priority,MaxJobsPU,MaxSubmitPU,MaxWall,MaxTRESPU,MaxTRESPJ,GrpTRES,GrpJobs,Flags";
  const script = `#!/bin/bash
set +e
echo "${marker}_START"
sacctmgr -P -n show qos format=${format} 2>&1
echo "${marker}_END"
`;
  try {
    const blob = await runOnController(id, script);
    const s = blob.indexOf(`${marker}_START`);
    const e = blob.indexOf(`${marker}_END`);
    const body = s !== -1 && e !== -1 ? blob.slice(s + marker.length + 6, e).trim() : "";
    const rows: QosRow[] = [];
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const f = line.split("|");
      if (f.length < 10 || !f[0]) continue;
      rows.push({
        name: f[0],
        priority: f[1],
        maxJobsPU: f[2],
        maxSubmitPU: f[3],
        maxWall: f[4],
        maxTRESPU: f[5],
        maxTRESPJ: f[6],
        grpTRES: f[7],
        grpJobs: f[8],
        flags: f[9],
      });
    }
    return NextResponse.json({ qos: rows });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}

function shellEscape(s: string): string {
  if (/^[A-Za-z0-9_,=+\-:\/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildSetExpr(fields: Partial<Record<QosField, string>>): string {
  const tokens: string[] = [];
  for (const key of QOS_FIELDS) {
    const v = fields[key];
    if (v === undefined) continue;
    // Empty string = clear (sacctmgr uses `-1` / `-` depending on field; we
    // pass the literal, leaving interpretation to the user).
    tokens.push(`${key}=${v === "" ? "-1" : shellEscape(v)}`);
  }
  return tokens.join(" ");
}

// POST /api/clusters/[id]/qos — create a QoS.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const body = (await req.json()) as { name?: string } & Partial<Record<QosField, string>>;
  const name = (body.name ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return NextResponse.json({ error: "Invalid QoS name (A-Z, 0-9, _, -)" }, { status: 400 });
  }

  const setExpr = buildSetExpr(body);
  const marker = `__QOS_CREATE_${Date.now()}__`;
  const script = `#!/bin/bash
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"
echo "${marker}_START"
$S sacctmgr -i add qos ${shellEscape(name)} ${setExpr ? "set " + setExpr : ""} 2>&1
ec=$?
echo "${marker}_END:$ec"
`;

  try {
    const blob = await runOnController(id, script);
    const s = blob.indexOf(`${marker}_START`);
    const endMatch = blob.match(new RegExp(`${marker}_END:(\\d+)`));
    const exit = endMatch ? parseInt(endMatch[1], 10) : null;
    const eIdx = endMatch ? blob.indexOf(endMatch[0]) : -1;
    const out = s !== -1 && eIdx !== -1
      ? blob.slice(s + marker.length + 6, eIdx).trim()
      : blob.trim();

    await logAudit({
      action: "qos.create",
      entity: "Cluster",
      entityId: id,
      metadata: { name, success: exit === 0 },
    });
    if (exit !== 0) return NextResponse.json({ error: out || "sacctmgr failed" }, { status: 400 });
    return NextResponse.json({ created: name, output: out });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}
