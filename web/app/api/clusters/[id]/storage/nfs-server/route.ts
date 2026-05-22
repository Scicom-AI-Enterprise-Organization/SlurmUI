/**
 * Provision (or tear down) an NFS server on a chosen cluster node.
 *
 * This handles ONLY the server side: install nfs-kernel-server / nfs-utils,
 * mkdir the export directory, manage /etc/exports, exportfs -ra. Mounting
 * the export onto client nodes is done by a separate "Add Mount" entry in
 * the Storage tab.
 *
 * Same task pattern as /storage/deploy — creates a BackgroundTask row that
 * the UI polls for realtime logs.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";
import { registerRunningTask } from "@/lib/running-tasks";

interface RouteParams { params: Promise<{ id: string }> }

interface HostEntry {
  hostname: string;
  ip: string;
  user?: string;
  port?: number;
}

export interface NfsServer {
  id: string;
  hostNode: string;        // hostname of the cluster node serving the export
  exportPath: string;      // path on that node, e.g. /srv/aura-nfs
  allowedNetwork: string;  // /etc/exports allow list — CIDR, hostname, or "*"
}

function provisionScript(server: NfsServer, host: HostEntry): string {
  const u = host.user || "root";
  const p = host.port || 22;
  // exportfs interprets 0.0.0.0/0 inconsistently across kernels — same
  // translation the bootstrap nfs_server role does.
  const allow = (server.allowedNetwork || "*").trim();
  const allowOut = allow === "0.0.0.0/0" || allow === "0/0" ? "*" : allow;

  return `#!/bin/bash
set -euo pipefail

echo "============================================"
echo "  Provisioning NFS server"
echo "  Host node: ${host.hostname} (${host.ip})"
echo "  Export:    ${server.exportPath}"
echo "  Allow:     ${allowOut}"
echo "============================================"
echo ""

ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p ${p} ${u}@${host.ip} bash -s <<'NFS_SERVER_EOF'
set -euo pipefail
S=""; [ "$(id -u)" != "0" ] && S="sudo"

if command -v exportfs >/dev/null 2>&1; then
  echo "  nfs server tools already present"
else
  echo "  installing nfs-kernel-server / nfs-utils ..."
  $S apt-get update -qq 2>/dev/null || true
  $S apt-get install -y -qq nfs-kernel-server 2>/dev/null \\
    || $S yum install -y -q nfs-utils 2>/dev/null \\
    || { echo "  FATAL: no apt or yum on this host"; exit 1; }
fi

$S mkdir -p ${server.exportPath}
# 1777 = world-writable with sticky bit, same as /tmp — anyone with shell
# access can drop files in but only the owner (or root) can delete them.
# That matches how a shared scratch NFS is usually used; admins can tighten
# this later via the Fix Permissions action.
$S chmod 1777 ${server.exportPath}
echo "  ensured export dir ${server.exportPath} (mode 1777)"

EXPORT_LINE='${server.exportPath} ${allowOut}(rw,sync,no_subtree_check,no_root_squash)'
if $S grep -qE "^\\s*${server.exportPath}\\s" /etc/exports 2>/dev/null; then
  # Already exported — overwrite the allow list to match current config.
  $S sed -i "\\|^\\s*${server.exportPath}\\s|c\\\\
$EXPORT_LINE" /etc/exports
  echo "  updated /etc/exports entry"
else
  echo "$EXPORT_LINE" | $S tee -a /etc/exports > /dev/null
  echo "  appended /etc/exports entry"
fi

$S systemctl enable --now nfs-kernel-server >/dev/null 2>&1 \\
  || $S systemctl enable --now nfs-server >/dev/null 2>&1 \\
  || true

$S exportfs -ra
echo ""
echo "  current exports on ${host.hostname}:"
$S exportfs -v 2>&1 | sed 's/^/    /'
NFS_SERVER_EOF

echo ""
echo "============================================"
echo "  NFS server ready"
echo "  Other nodes can now mount ${host.ip}:${server.exportPath}"
echo "============================================"
`;
}

function unprovisionScript(server: NfsServer, host: HostEntry): string {
  const u = host.user || "root";
  const p = host.port || 22;

  return `#!/bin/bash
set +e

echo "============================================"
echo "  Removing NFS export"
echo "  Host node: ${host.hostname} (${host.ip})"
echo "  Export:    ${server.exportPath}"
echo "============================================"
echo ""

ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p ${p} ${u}@${host.ip} bash -s <<'NFS_UNEXPORT_EOF'
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"

if [ -f /etc/exports ]; then
  $S sed -i "\\|^\\s*${server.exportPath}\\s|d" /etc/exports
  echo "  stripped /etc/exports entry"
  $S exportfs -ra 2>/dev/null || true
fi

# We deliberately do NOT remove the export directory — it may hold user data.
# We also leave nfs-kernel-server installed; other exports on the same node
# could rely on it.

echo "  current exports on $(hostname):"
$S exportfs -v 2>&1 | sed 's/^/    /'
NFS_UNEXPORT_EOF

echo ""
echo "============================================"
echo "  NFS export removed"
echo "============================================"
`;
}

// POST /api/clusters/[id]/storage/nfs-server
//   body: { server: NfsServer, action?: "deploy" | "remove" }
//   returns: { taskId }
export async function POST(req: NextRequest, { params }: RouteParams) {
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
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key assigned" }, { status: 412 });

  const body = await req.json();
  const server = body.server as NfsServer;
  const action = body.action === "remove" ? "remove" : "deploy";

  if (!server || !server.id || !server.hostNode || !server.exportPath) {
    return NextResponse.json({ error: "Invalid server configuration" }, { status: 400 });
  }
  if (!server.exportPath.startsWith("/")) {
    return NextResponse.json({ error: "exportPath must be absolute" }, { status: 400 });
  }

  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const host = hostsEntries.find((h) => h.hostname === server.hostNode);
  if (!host) {
    return NextResponse.json({
      error: `Node '${server.hostNode}' not found in cluster.`,
    }, { status: 400 });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const script = action === "remove"
    ? unprovisionScript(server, host)
    : provisionScript(server, host);

  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: action === "remove" ? "nfs_server_remove" : "nfs_server_deploy" },
  });

  // Serialise log appends through a chained promise so concurrent onStream
  // lines land in arrival order (otherwise independent async UPDATEs race
  // and the UI log shows shuffled lines).
  let writeChain: Promise<unknown> = Promise.resolve();
  const appendLog = (line: string) => {
    writeChain = writeChain
      .then(() =>
        prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${line + "\n"} WHERE id = ${task.id}`,
      )
      .catch(() => {});
    return writeChain;
  };

  (async () => {
    await appendLog(`[aura] ${action === "remove" ? "Tearing down" : "Provisioning"} NFS server ${server.hostNode}:${server.exportPath}`);
    const handle = sshExecScript(target, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          await appendLog(`\n[aura] NFS server ${action === "remove" ? "removed" : "ready"}.`);
          logAudit({
            action: action === "remove" ? "storage.nfs_server.remove" : "storage.nfs_server.deploy",
            entity: "Cluster",
            entityId: id,
            metadata: { hostNode: server.hostNode, exportPath: server.exportPath },
          });
        } else {
          await appendLog(`\n[aura] ${action === "remove" ? "Remove" : "Provision"} failed or was cancelled.`);
        }
        await prisma.backgroundTask.update({
          where: { id: task.id },
          data: { status: success ? "success" : "failed", completedAt: new Date() },
        }).catch(() => {});
      },
    });
    registerRunningTask(task.id, handle);
  })();

  return NextResponse.json({ taskId: task.id });
}
