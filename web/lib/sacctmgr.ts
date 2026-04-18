import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

// Shared helper for API routes that shell out to `sacctmgr` on the controller.
// Wraps the invocation in __MARKER_{START,END:exit}__ so shell banners on
// bastion connections get stripped out cleanly.

export async function runSacctmgrOnCluster(clusterId: string, inner: string): Promise<{
  ok: boolean;
  exit: number | null;
  output: string;
}> {
  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    include: { sshKey: true },
  });
  if (!cluster) throw Object.assign(new Error("Cluster not found"), { status: 404 });
  if (!cluster.sshKey) throw Object.assign(new Error("No SSH key"), { status: 412 });
  if (cluster.connectionMode !== "SSH") {
    throw Object.assign(new Error("Only supported in SSH mode"), { status: 412 });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const marker = `__SAM_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
  const script = `#!/bin/bash
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"
echo "${marker}_START"
${inner}
ec=$?
echo "${marker}_END:$ec"
`;

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });

  const blob = chunks.join("\n");
  const s = blob.indexOf(`${marker}_START`);
  const endMatch = blob.match(new RegExp(`${marker}_END:(\\d+)`));
  const exit = endMatch ? parseInt(endMatch[1], 10) : null;
  const eIdx = endMatch ? blob.indexOf(endMatch[0]) : -1;
  const output = s !== -1 && eIdx !== -1
    ? blob.slice(s + marker.length + 6, eIdx).trim()
    : blob.trim();

  return { ok: exit === 0, exit, output };
}

export function shellEscape(s: string): string {
  if (/^[A-Za-z0-9_,=+\-:\/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function validName(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s);
}
