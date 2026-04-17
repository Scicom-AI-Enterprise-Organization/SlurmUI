import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
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

interface StorageMount {
  id: string;
  type: "nfs" | "s3fs";
  mountPath: string;
  nfsServer?: string;
  nfsPath?: string;
  s3Bucket?: string;
  s3Endpoint?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Region?: string;
}

function buildNfsScript(mount: StorageMount, workers: HostEntry[]): string {
  const workerBlock = workers.map((w) => {
    const u = w.user || "root";
    const p = w.port || 22;
    return `
echo "  Setting up ${w.hostname} (${w.ip})..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${w.ip} bash -s <<'NODE_EOF'
set -euo pipefail
S=""; [ "$(id -u)" != "0" ] && S="sudo"
$S apt-get install -y -qq nfs-common 2>/dev/null || $S yum install -y -q nfs-utils 2>/dev/null || true
$S mkdir -p ${mount.mountPath}
$S grep -q '${mount.nfsServer}:${mount.nfsPath}' /etc/fstab || echo '${mount.nfsServer}:${mount.nfsPath} ${mount.mountPath} nfs defaults,_netdev 0 0' | $S tee -a /etc/fstab > /dev/null
$S mount -a
df -h ${mount.mountPath}
echo "  Done"
NODE_EOF`;
  }).join("\n");

  return `#!/bin/bash
set -euo pipefail

echo "============================================"
echo "  Deploying NFS mount: ${mount.mountPath}"
echo "  Source: ${mount.nfsServer}:${mount.nfsPath}"
echo "  Targets: ${workers.length} node(s)"
echo "============================================"
echo ""
${workerBlock}
echo ""
echo "============================================"
echo "  NFS mount deployed successfully!"
echo "============================================"
`;
}

function buildS3fsScript(mount: StorageMount, workers: HostEntry[]): string {
  // If user provided a custom endpoint (MinIO/Ceph etc.), use that.
  // Otherwise for AWS, derive the regional URL so non-us-east-1 buckets work.
  let urlOpt = "";
  let usePathStyle = "";
  if (mount.s3Endpoint) {
    urlOpt = `-o url=${mount.s3Endpoint}`;
    usePathStyle = `-o use_path_request_style`;
  } else if (mount.s3Region && mount.s3Region !== "us-east-1") {
    urlOpt = `-o url=https://s3.${mount.s3Region}.amazonaws.com`;
  }
  const endpointOpt = `${urlOpt} ${usePathStyle}`.trim();
  const regionOpt = mount.s3Region ? `-o endpoint=${mount.s3Region}` : "";
  const credFile = `/etc/passwd-s3fs-${mount.id.slice(0, 8)}`;

  const workerBlock = workers.map((w) => {
    const u = w.user || "root";
    const p = w.port || 22;
    return `
echo "  Setting up ${w.hostname} (${w.ip})..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${w.ip} bash -s <<'NODE_EOF'
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"

# Install s3fs
$S apt-get install -y -qq s3fs fuse 2>/dev/null || $S yum install -y -q s3fs-fuse fuse 2>/dev/null || true

# Enable user_allow_other in FUSE config (needed for allow_other option)
if [ -f /etc/fuse.conf ]; then
  $S sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf
  grep -q '^user_allow_other' /etc/fuse.conf || echo "user_allow_other" | $S tee -a /etc/fuse.conf > /dev/null
fi

# Write credentials
echo '${mount.s3AccessKey}:${mount.s3SecretKey}' | $S tee ${credFile} > /dev/null
$S chmod 600 ${credFile}
$S mkdir -p ${mount.mountPath}

# Force cleanup of any previous mount (including stale/disconnected FUSE mounts)
$S fusermount -u ${mount.mountPath} 2>/dev/null || true
$S umount -f ${mount.mountPath} 2>/dev/null || true
$S umount -l ${mount.mountPath} 2>/dev/null || true
# If the mount point is in "Transport endpoint is not connected" state, recreate it
if ! ls ${mount.mountPath} >/dev/null 2>&1; then
  $S rm -rf ${mount.mountPath} 2>/dev/null || true
fi
$S mkdir -p ${mount.mountPath}

# Mount — s3fs daemonizes so we need to wait + verify, then fish errors from syslog
$S s3fs ${mount.s3Bucket} ${mount.mountPath} -o passwd_file=${credFile} ${endpointOpt} ${regionOpt} -o allow_other -o dbglevel=info 2>&1 | sed 's/^/    s3fs: /'
sleep 2

if mountpoint -q ${mount.mountPath}; then
  echo "  s3fs mount successful"
  df -h ${mount.mountPath} | sed 's/^/    /'
  # Persist in fstab for reboot
  FSTAB_URL_OPT="${mount.s3Endpoint ? `,url=${mount.s3Endpoint},use_path_request_style` : (mount.s3Region && mount.s3Region !== "us-east-1" ? `,url=https://s3.${mount.s3Region}.amazonaws.com` : "")}"
  FSTAB_LINE="${mount.s3Bucket} ${mount.mountPath} fuse.s3fs _netdev,allow_other,passwd_file=${credFile}\${FSTAB_URL_OPT}${mount.s3Region ? `,endpoint=${mount.s3Region}` : ""} 0 0"
  $S grep -q '${mount.mountPath} ' /etc/fstab || echo "$FSTAB_LINE" | $S tee -a /etc/fstab > /dev/null
else
  echo "  ERROR: s3fs mount failed"
  echo "  Recent s3fs errors from syslog:"
  $S journalctl --no-pager -n 50 --since "1 min ago" 2>/dev/null | grep -i s3fs | tail -15 | sed 's/^/    /' || \
    $S tail -100 /var/log/syslog 2>/dev/null | grep -i s3fs | tail -15 | sed 's/^/    /' || \
    echo "    (no syslog access)"
  exit 1
fi
echo "  Done on ${w.hostname}"
NODE_EOF`;
  }).join("\n");

  return `#!/bin/bash
set -euo pipefail

echo "============================================"
echo "  Deploying S3 mount: ${mount.mountPath}"
echo "  Bucket: ${mount.s3Bucket}"
echo "  Targets: ${workers.length} node(s)"
echo "============================================"
echo ""
${workerBlock}
echo ""
echo "============================================"
echo "  S3 mount deployed successfully!"
echo "============================================"
`;
}

function buildRemoveScript(mount: StorageMount, workers: HostEntry[]): string {
  const credFile = `/etc/passwd-s3fs-${mount.id.slice(0, 8)}`;
  const workerBlock = workers.map((w) => {
    const u = w.user || "root";
    const p = w.port || 22;
    return `
echo "  Cleaning up ${w.hostname} (${w.ip})..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${w.ip} bash -s <<'NODE_EOF'
set +e
S=""; [ "$(id -u)" != "0" ] && S="sudo"

# Unmount if currently mounted
if mountpoint -q ${mount.mountPath}; then
  $S fusermount -u ${mount.mountPath} 2>/dev/null || $S umount -f ${mount.mountPath} 2>/dev/null || $S umount -l ${mount.mountPath} 2>/dev/null || true
  echo "  unmounted ${mount.mountPath}"
fi

# Remove from fstab
if $S grep -q '${mount.mountPath} ' /etc/fstab 2>/dev/null; then
  $S sed -i "\\|${mount.mountPath} |d" /etc/fstab
  echo "  removed fstab entry"
fi

# Remove credentials file (s3fs only)
${mount.type === "s3fs" ? `$S rm -f ${credFile} 2>/dev/null && echo "  removed ${credFile}" || true` : ""}

# Remove mount point directory (only if empty)
$S rmdir ${mount.mountPath} 2>/dev/null && echo "  removed ${mount.mountPath}" || echo "  kept ${mount.mountPath} (not empty)"

echo "  Done on ${w.hostname}"
NODE_EOF`;
  }).join("\n");

  return `#!/bin/bash
set +e

echo "============================================"
echo "  Removing ${mount.type.toUpperCase()} mount: ${mount.mountPath}"
echo "  Targets: ${workers.length} node(s)"
echo "============================================"
echo ""
${workerBlock}
echo ""
echo "============================================"
echo "  Mount removed"
echo "============================================"
`;
}

// POST /api/clusters/[id]/storage/deploy
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
  const mount = body.mount as StorageMount;
  if (!mount || !mount.type || !mount.mountPath) {
    return NextResponse.json({ error: "Invalid mount configuration" }, { status: 400 });
  }

  const config = cluster.config as Record<string, unknown>;
  const controllerHost = config.slurm_controller_host as string;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const workers = hostsEntries.filter((h) => h.hostname !== controllerHost);

  // If no workers, target the controller itself
  const targets = workers.length > 0 ? workers : hostsEntries;

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
  };

  const action = body.action === "remove" ? "remove" : "deploy";
  const script = action === "remove"
    ? buildRemoveScript(mount, targets)
    : mount.type === "nfs"
      ? buildNfsScript(mount, targets)
      : buildS3fsScript(mount, targets);

  const enc = new TextEncoder();
  let seq = 0;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };

      sshExecScript(target, script, {
        onStream: (line, s) => {
          send({ type: "stream", line, seq: seq++ });
        },
        onComplete: (success, payload) => {
          if (success) {
            send({ type: "complete", success: true });
            logAudit({
              action: "storage.deploy",
              entity: "Cluster",
              entityId: id,
              metadata: { type: mount.type, mountPath: mount.mountPath, targets: targets.length },
            });
          } else {
            send({ type: "complete", success: false, message: `Exit code ${payload?.exitCode}` });
          }
          controller.close();
        },
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
