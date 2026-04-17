import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface HostEntry {
  hostname: string;
  ip: string;
  user?: string;
  port?: number;
}

// POST /api/clusters/[id]/packages/status — check install status on each worker
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
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const config = cluster.config as Record<string, unknown>;
  const packages = (config.installed_packages as string[]) ?? [];
  const controllerHost = config.slurm_controller_host as string;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const workers = hostsEntries.filter((h) => h.hostname !== controllerHost);
  const targets = workers.length > 0 ? workers : hostsEntries;

  if (packages.length === 0 || targets.length === 0) {
    return NextResponse.json({ statuses: {}, targets: [] });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const marker = `__PKG_STATUS_${Date.now()}__`;
  const pkgList = packages.map((p) => JSON.stringify(p)).join(" ");

  const checks = targets.map((w) => {
    const u = w.user || "root";
    const p = w.port || 22;
    return `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${w.ip} 'for pkg in ${pkgList}; do (dpkg -s "$pkg" >/dev/null 2>&1 || rpm -q "$pkg" >/dev/null 2>&1) && echo "${w.hostname}|$pkg|installed" || echo "${w.hostname}|$pkg|missing"; done' 2>/dev/null`;
  }).join("; ");

  const script = `echo "${marker}_START"; ${checks}; echo "${marker}_END"`;

  const rawChunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => rawChunks.push(line),
      onComplete: () => resolve(),
    });
  });

  const full = rawChunks.join("\n");
  const startIdx = full.indexOf(`${marker}_START`);
  const endIdx = full.indexOf(`${marker}_END`);
  const content = startIdx !== -1 && endIdx !== -1
    ? full.slice(startIdx + `${marker}_START`.length, endIdx)
    : full;

  // { [packageName]: { [hostname]: "installed" | "missing" } }
  const statuses: Record<string, Record<string, string>> = {};
  for (const pkg of packages) statuses[pkg] = {};

  for (const line of content.split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length === 3) {
      const [hostname, pkg, state] = parts;
      if (statuses[pkg]) {
        statuses[pkg][hostname] = state;
      }
    }
  }

  return NextResponse.json({ statuses, targets: targets.map((t) => t.hostname) });
}
