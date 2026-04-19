import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }
interface EnvVar { key: string; value?: string; secret?: boolean }
interface HostEntry { hostname: string; ip: string; user?: string; port?: number }

// POST — check, for each node, which env var keys are actually present in
// /etc/profile.d/aura.sh. Returns per-host boolean per key.
export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey) {
    return NextResponse.json({ error: "Cluster not reachable" }, { status: 412 });
  }

  const config = cluster.config as Record<string, unknown>;
  const vars: EnvVar[] = (config.os_environment as EnvVar[]) ?? [];
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const targets = hostsEntries.length > 0
    ? hostsEntries
    : [{ hostname: cluster.controllerHost, ip: cluster.controllerHost }];

  if (vars.length === 0) {
    return NextResponse.json({ perHost: {}, targets: [] });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const marker = `__ENV_STATUS_${Date.now()}__`;
  const perHost = targets.map((h) => {
    const u = h.user || "root";
    const p = h.port || 22;
    return `
echo "${marker}_HOST=${h.hostname}"
ssh -n -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${h.ip} '
  if [ ! -f /etc/profile.d/aura.sh ]; then echo "__NO_FILE__"; else
    grep -oE "^export [A-Za-z_][A-Za-z0-9_]*=" /etc/profile.d/aura.sh | sed "s/^export //;s/=\\$//";
  fi
' 2>/dev/null`;
  }).join("\n");

  const script = `#!/bin/bash
set +e
echo "${marker}_START"
${perHost}
echo "${marker}_END"
`;

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });

  const full = chunks.join("\n");
  const startIdx = full.indexOf(`${marker}_START`);
  const endIdx = full.indexOf(`${marker}_END`);
  const body = startIdx !== -1 && endIdx !== -1
    ? full.slice(startIdx + `${marker}_START`.length, endIdx)
    : full;

  // Split by __MARKER_HOST=... blocks.
  const sections = body.split(new RegExp(`${marker}_HOST=`)).slice(1);
  const perHostResult: Record<string, Record<string, boolean>> = {};
  const hostList: string[] = [];
  for (const sec of sections) {
    const nl = sec.indexOf("\n");
    if (nl === -1) continue;
    const host = sec.slice(0, nl).trim();
    const content = sec.slice(nl + 1);
    hostList.push(host);
    const present = new Set<string>();
    if (!content.includes("__NO_FILE__")) {
      for (const line of content.split("\n")) {
        const k = line.trim();
        if (k && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) present.add(k);
      }
    }
    const status: Record<string, boolean> = {};
    for (const v of vars) status[v.key] = present.has(v.key);
    perHostResult[host] = status;
  }

  return NextResponse.json({ perHost: perHostResult, targets: hostList });
}
