/**
 * Make a storage mount writable for the web user.
 *
 * Symptom we're fixing: writes fail with "Permission denied" because the
 * mount (NFS export or s3fs path) is owned by a different unix user than
 * the SSH account, and "other" doesn't have the write bit.
 *
 * Strategy: from the controller, SSH into one node that has the mount and
 * run `chmod <mode> <mountPath>` there. For NFS this mutates the actual
 * directory on the server; for s3fs it updates the per-object metadata
 * stored in S3, which every client then sees.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getApiUser } from "@/lib/api-auth";
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

interface StorageMount {
  id: string;
  type: "nfs" | "s3fs";
  mountPath: string;
  nfsServerId?: string;
}

// POST /api/clusters/[id]/storage/chmod
//   body: { mountId: string, mode?: string, recursive?: boolean }
//   returns: { taskId }
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  // auth: accepts both NextAuth session cookies (UI) and Bearer aura_*
  // tokens (CLI / v1 wrappers) via getApiUser.
  const apiUser = await getApiUser(req);
  if (!apiUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (apiUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const body = await req.json();
  const mountId = body.mountId as string;
  const mode = typeof body.mode === "string" && /^[0-7]{3,4}$/.test(body.mode)
    ? body.mode
    : "0777";
  const recursive = body.recursive === true;

  const config = cluster.config as Record<string, unknown>;
  const mounts = (config.storage_mounts ?? []) as StorageMount[];
  const mount = mounts.find((m) => m.id === mountId);
  if (!mount) {
    return NextResponse.json({ error: "Mount not found" }, { status: 404 });
  }

  const controllerHost = config.slurm_controller_host as string;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];

  // Pick the node we should run chmod on. For self-hosted NFS the mount
  // lives on every node including the server itself, so any node works;
  // we prefer the server (no extra hop). For external NFS / S3, prefer
  // a worker (those are guaranteed to have the mount); fall back to the
  // controller when no workers are registered.
  let targetNode: HostEntry | undefined;
  if (mount.nfsServerId) {
    const servers = (config.nfs_servers ?? []) as Array<{ id: string; hostNode: string }>;
    const srv = servers.find((s) => s.id === mount.nfsServerId);
    if (srv) targetNode = hostsEntries.find((h) => h.hostname === srv.hostNode);
  }
  if (!targetNode) {
    const workers = hostsEntries.filter((h) => h.hostname !== controllerHost);
    targetNode = workers[0] ?? hostsEntries[0];
  }
  if (!targetNode) {
    return NextResponse.json({ error: "No cluster nodes registered" }, { status: 412 });
  }

  const sshTarget = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const u = targetNode.user || "root";
  const p = targetNode.port || 22;
  // Recursive chmod on s3fs/NFS can walk many files; without -R we only
  // touch the mount root, which covers most "Permission denied" cases.
  const flag = recursive ? "-Rv " : "-v ";

  // Stream a heartbeat every N seconds so the UI doesn't look frozen during
  // a long recursive walk on s3fs (every file = one S3 PUT for x-amz-meta).
  // Sampled chmod output so the BackgroundTask log doesn't balloon.
  const script = `#!/bin/bash
set +e

echo "============================================"
echo "  Fixing permissions on ${mount.mountPath}"
echo "  Target node: ${targetNode.hostname} (${targetNode.ip})"
echo "  Mode: ${mode}${recursive ? " (recursive)" : ""}"
${recursive && mount.type === "s3fs"
  ? `echo "  Note: s3fs recursive chmod issues one S3 PUT per file — can take minutes."` : "echo ''"}
echo "============================================"
echo ""

ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p ${p} ${u}@${targetNode.ip} bash -s <<'CHMOD_EOF'
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"

if ! mountpoint -q ${mount.mountPath}; then
  echo "  WARNING: ${mount.mountPath} is not currently mounted on $(hostname)."
  echo "  Mount it via the Plug button first, then re-run Fix Permissions."
  exit 1
fi

echo "  before:"
ls -ld ${mount.mountPath} 2>&1 | sed 's/^/    /'

# Background heartbeat so the user sees the operation is alive even when
# chmod is grinding through a slow s3fs walk between -v lines.
HB_PID=""
(
  i=0
  while sleep 5; do
    i=$((i + 5))
    echo "  ... still working (\${i}s elapsed)"
  done
) &
HB_PID=$!

# -v prints "mode of 'path' changed ..." per file. Sample so the log stays
# readable even with thousands of files: keep the first 10 + every 200th +
# always print errors.
$S chmod ${flag}${mode} ${mount.mountPath} 2>&1 \\
  | awk 'BEGIN{c=0;e=0}
         /retained as|mode of/ {c++; if (c<=10 || c%200==0) print "  ["c"] " $0; next}
         /^chmod:/ {e++; print "  ERR: " $0; next}
         {print "  "$0}
         END{print "  -- processed " c " entries, " e " errors --"}'
RC=\${PIPESTATUS[0]}

kill "$HB_PID" 2>/dev/null
wait "$HB_PID" 2>/dev/null

if [ $RC -ne 0 ]; then
  echo "  chmod exited with code $RC"
  exit $RC
fi

echo "  after:"
ls -ld ${mount.mountPath} 2>&1 | sed 's/^/    /'
echo "  Done"
CHMOD_EOF

echo ""
echo "============================================"
echo "  Permissions updated"
echo "============================================"
`;

  const task = await prisma.backgroundTask.create({
    data: { clusterId: id, type: "storage_chmod" },
  });

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
    await appendLog(`[aura] chmod ${mode}${recursive ? " -R" : ""} ${mount.mountPath} via ${targetNode!.hostname}`);
    const handle = sshExecScript(sshTarget, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          appendLog(trimmed);
        }
      },
      onComplete: async (success) => {
        if (success) {
          await appendLog(`\n[aura] Permissions updated.`);
          logAudit({
            action: "storage.chmod",
            entity: "Cluster",
            entityId: id,
            metadata: { mountPath: mount.mountPath, mode, recursive },
          });
        } else {
          await appendLog(`\n[aura] chmod failed.`);
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
