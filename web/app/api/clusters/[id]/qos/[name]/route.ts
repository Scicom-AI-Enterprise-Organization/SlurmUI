import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";
import { logAudit } from "@/lib/audit";
import { QOS_FIELDS, type QosField } from "@/lib/qos-fields";

interface RouteParams { params: Promise<{ id: string; name: string }> }

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

async function requireAdmin() {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session };
}

function shellEscape(s: string): string {
  if (/^[A-Za-z0-9_,=+\-:\/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runScontrolWithMarker(clusterId: string, inner: string) {
  const marker = `__QOS_${Date.now()}__`;
  const blob = await runOnController(
    clusterId,
    `#!/bin/bash\nset +e\nS=""; [ "$(id -u)" != "0" ] && S="sudo"\necho "${marker}_START"\n${inner}\nec=$?\necho "${marker}_END:$ec"\n`,
  );
  const s = blob.indexOf(`${marker}_START`);
  const endMatch = blob.match(new RegExp(`${marker}_END:(\\d+)`));
  const exit = endMatch ? parseInt(endMatch[1], 10) : null;
  const eIdx = endMatch ? blob.indexOf(endMatch[0]) : -1;
  const out = s !== -1 && eIdx !== -1
    ? blob.slice(s + marker.length + 6, eIdx).trim()
    : blob.trim();
  return { exit, out };
}

// PATCH /api/clusters/[id]/qos/[name] — modify an existing QoS.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, name } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return NextResponse.json({ error: "Invalid QoS name" }, { status: 400 });
  }

  const body = (await req.json()) as Partial<Record<QosField, string>>;
  const tokens: string[] = [];
  for (const key of QOS_FIELDS) {
    const v = body[key];
    if (v === undefined) continue;
    tokens.push(`${key}=${v === "" ? "-1" : shellEscape(v)}`);
  }
  if (tokens.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  try {
    const { exit, out } = await runScontrolWithMarker(
      id,
      `$S sacctmgr -i modify qos ${shellEscape(name)} set ${tokens.join(" ")} 2>&1`,
    );
    await logAudit({
      action: "qos.modify",
      entity: "Cluster",
      entityId: id,
      metadata: { name, fields: Object.keys(body), success: exit === 0 },
    });
    if (exit !== 0) return NextResponse.json({ error: out || "sacctmgr failed" }, { status: 400 });
    return NextResponse.json({ updated: name, output: out });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}

// DELETE /api/clusters/[id]/qos/[name]
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id, name } = await params;
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return NextResponse.json({ error: "Invalid QoS name" }, { status: 400 });
  }
  if (name.toLowerCase() === "normal") {
    return NextResponse.json({ error: "Cannot delete the built-in 'normal' QoS" }, { status: 400 });
  }

  try {
    const { exit, out } = await runScontrolWithMarker(
      id,
      `$S sacctmgr -i delete qos where name=${shellEscape(name)} 2>&1`,
    );
    await logAudit({
      action: "qos.delete",
      entity: "Cluster",
      entityId: id,
      metadata: { name, success: exit === 0 },
    });
    if (exit !== 0) return NextResponse.json({ error: out || "sacctmgr failed" }, { status: 400 });
    return NextResponse.json({ deleted: name, output: out });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return NextResponse.json({ error: e.message ?? "Failed" }, { status: e.status ?? 500 });
  }
}
