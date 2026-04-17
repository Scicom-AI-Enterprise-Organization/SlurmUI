import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string }> }

// POST — check which python packages are currently installed in the shared venv.
// Since the venv lives on shared storage, a single `pip list` on the controller
// is authoritative for every node.
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
  const venvLocation = (config.python_venv_location as string) ?? "";
  const installMode = ((config.python_install_mode as string) ?? "shared") as "shared" | "per-node";
  const localVenvPath = (config.python_local_venv_path as string) ?? "/opt/aura-venv";
  const isShared = installMode === "shared";

  if (isShared && !venvLocation) {
    return NextResponse.json({ statuses: {}, venvExists: false, mode: "shared" });
  }
  const venvPath = isShared
    ? `${venvLocation.replace(/\/+$/, "")}/aura-venv`
    : localVenvPath.replace(/\/+$/, "");

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const marker = `__PYPKG_STATUS_${Date.now()}__`;
  const uvBinDir = isShared
    ? `${venvLocation.replace(/\/+$/, "")}/uv-bin`
    : `${venvPath}-uv-bin`;

  // Check a single venv (used inline for shared, or embedded per-host for per-node).
  const checkOne = `
if [ ! -f "${venvPath}/bin/python" ]; then
  echo "__NO_VENV__"
else
  UV="${uvBinDir}/uv"
  [ ! -x "$UV" ] && [ -x "${uvBinDir}/bin/uv" ] && UV="${uvBinDir}/bin/uv"
  if [ -x "$UV" ]; then
    "$UV" pip list --python "${venvPath}/bin/python" --format=freeze 2>/dev/null
  else
    "${venvPath}/bin/python" -m pip list --format=freeze 2>/dev/null
  fi
fi`;

  let script: string;
  if (isShared) {
    script = `#!/bin/bash
set +e
echo "${marker}_START"
${checkOne}
echo "${marker}_END"
`;
  } else {
    interface HostEntry { hostname: string; ip: string; user?: string; port?: number }
    const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
    const targets = hostsEntries.length > 0 ? hostsEntries : [{ hostname: cluster.controllerHost, ip: cluster.controllerHost }];

    const perHost = targets.map((h) => {
      const u = h.user || "root";
      const p = h.port || 22;
      return `
echo "${marker}_HOST=${h.hostname}"
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${h.ip} bash -s <<'HOST_EOF' 2>/dev/null
set +e
${checkOne}
HOST_EOF`;
    }).join("\n");

    script = `#!/bin/bash
set +e
echo "${marker}_START"
${perHost}
echo "${marker}_END"
`;
  }

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => {
        if (!line.startsWith("[stderr]")) chunks.push(line);
      },
      onComplete: () => resolve(),
    });
  });

  const full = chunks.join("\n");
  const startIdx = full.indexOf(`${marker}_START`);
  const endIdx = full.indexOf(`${marker}_END`);
  const body = startIdx !== -1 && endIdx !== -1
    ? full.slice(startIdx + `${marker}_START`.length, endIdx)
    : full;

  const rawPackages = (config.python_packages as unknown[]) ?? [];
  const packages = rawPackages.map((p) =>
    typeof p === "string" ? { name: p } : (p as { name: string })
  );

  const parseFreeze = (text: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const line of text.split("\n")) {
      const mm = line.trim().match(/^([A-Za-z0-9_.\-]+)\s*==\s*(\S+)/);
      if (mm) m.set(mm[1].toLowerCase().replace(/_/g, "-"), mm[2]);
    }
    return m;
  };
  const bareName = (n: string) =>
    n.split(/[\[=<>!~]/)[0].trim().toLowerCase().replace(/_/g, "-");

  if (isShared) {
    if (body.includes("__NO_VENV__")) {
      return NextResponse.json({ statuses: {}, venvExists: false, mode: "shared" });
    }
    const installed = parseFreeze(body);
    const statuses: Record<string, { installed: boolean; version?: string }> = {};
    for (const pkg of packages) {
      const v = installed.get(bareName(pkg.name));
      statuses[pkg.name] = v ? { installed: true, version: v } : { installed: false };
    }
    return NextResponse.json({ statuses, venvExists: true, mode: "shared" });
  }

  // per-node: split by __MARKER_HOST=...
  const sections = body.split(new RegExp(`${marker}_HOST=`)).slice(1);
  const perHost: Record<string, Record<string, { installed: boolean; version?: string }>> = {};
  const targets: string[] = [];
  for (const sec of sections) {
    const nl = sec.indexOf("\n");
    if (nl === -1) continue;
    const host = sec.slice(0, nl).trim();
    const content = sec.slice(nl + 1);
    targets.push(host);
    const hostStatus: Record<string, { installed: boolean; version?: string }> = {};
    if (content.includes("__NO_VENV__")) {
      for (const pkg of packages) hostStatus[pkg.name] = { installed: false };
    } else {
      const installed = parseFreeze(content);
      for (const pkg of packages) {
        const v = installed.get(bareName(pkg.name));
        hostStatus[pkg.name] = v ? { installed: true, version: v } : { installed: false };
      }
    }
    perHost[host] = hostStatus;
  }

  return NextResponse.json({ perHost, targets, mode: "per-node" });
}
