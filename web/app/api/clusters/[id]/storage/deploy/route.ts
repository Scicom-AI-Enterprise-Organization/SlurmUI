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
apt-get install -y -qq nfs-common 2>/dev/null || yum install -y -q nfs-utils 2>/dev/null || true
mkdir -p ${mount.mountPath}
grep -q '${mount.nfsServer}:${mount.nfsPath}' /etc/fstab || echo '${mount.nfsServer}:${mount.nfsPath} ${mount.mountPath} nfs defaults,_netdev 0 0' >> /etc/fstab
mount -a
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
  const endpointOpt = mount.s3Endpoint ? `-o url=${mount.s3Endpoint} -o use_path_request_style` : "";
  const regionOpt = mount.s3Region ? `-o endpoint=${mount.s3Region}` : "";
  const credFile = `/etc/passwd-s3fs-${mount.id.slice(0, 8)}`;

  const workerBlock = workers.map((w) => {
    const u = w.user || "root";
    const p = w.port || 22;
    return `
echo "  Setting up ${w.hostname} (${w.ip})..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${p} ${u}@${w.ip} bash -s <<'NODE_EOF'
set -euo pipefail
apt-get install -y -qq s3fs fuse 2>/dev/null || yum install -y -q s3fs-fuse fuse 2>/dev/null || true
echo '${mount.s3AccessKey}:${mount.s3SecretKey}' > ${credFile}
chmod 600 ${credFile}
mkdir -p ${mount.mountPath}
mountpoint -q ${mount.mountPath} && echo "  Already mounted" || s3fs ${mount.s3Bucket} ${mount.mountPath} -o passwd_file=${credFile} ${endpointOpt} ${regionOpt} -o allow_other
df -h ${mount.mountPath}
echo "  Done"
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

  const script = mount.type === "nfs"
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
