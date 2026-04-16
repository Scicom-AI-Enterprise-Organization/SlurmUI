import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/storage/test — test NFS/S3 connectivity via SSH
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
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const body = await req.json();
  const { type, nfsServer, nfsPath, s3Bucket, s3Endpoint, s3AccessKey, s3SecretKey, s3Region } = body;

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  let script: string;
  const marker = `__AURA_TEST_${Date.now()}__`;

  if (type === "nfs") {
    script = `#!/bin/bash
S=""
if [ "$(id -u)" != "0" ]; then S="sudo"; fi

echo "${marker}_START"

$S apt-get install -y -qq nfs-common 2>/dev/null || $S yum install -y -q nfs-utils 2>/dev/null || true

SHOWMOUNT=$(showmount -e ${nfsServer} 2>&1)
if echo "$SHOWMOUNT" | grep -q "${nfsPath}"; then
  echo "RESULT_OK"
else
  echo "RESULT_FAIL"
  echo "$SHOWMOUNT"
fi

echo "${marker}_END"
`;
  } else {
    script = `#!/bin/bash
S=""
if [ "$(id -u)" != "0" ]; then S="sudo"; fi

echo "${marker}_START"

# Install s3fs
$S apt-get install -y -qq s3fs fuse curl 2>/dev/null || $S yum install -y -q s3fs-fuse fuse curl 2>/dev/null || true

if ! command -v s3fs &>/dev/null; then
  echo "RESULT_FAIL"
  echo "s3fs is not installed on the controller"
  echo "${marker}_END"
  exit 0
fi

# Check endpoint reachability
${s3Endpoint ? `
if ! curl -sf --max-time 10 -o /dev/null "${s3Endpoint}"; then
  echo "RESULT_FAIL"
  echo "Cannot reach S3 endpoint: ${s3Endpoint}"
  echo "${marker}_END"
  exit 0
fi
` : ""}

# Write credentials and try to mount
CRED=/tmp/.aura-s3-test-$$
MNT=/tmp/.aura-s3-mnt-$$
echo '${s3AccessKey}:${s3SecretKey}' > $CRED
chmod 600 $CRED
mkdir -p $MNT

$S s3fs ${s3Bucket} $MNT -o passwd_file=$CRED ${s3Endpoint ? `-o url=${s3Endpoint} -o use_path_request_style` : ""} ${s3Region ? `-o endpoint=${s3Region}` : ""} -o allow_other 2>/tmp/.aura-s3-err-$$

sleep 2

if mountpoint -q $MNT 2>/dev/null; then
  echo "RESULT_OK"
  $S fusermount -u $MNT 2>/dev/null || $S umount $MNT 2>/dev/null || true
else
  echo "RESULT_FAIL"
  cat /tmp/.aura-s3-err-$$ 2>/dev/null || echo "Mount failed silently"
fi

rm -f $CRED /tmp/.aura-s3-err-$$
rmdir $MNT 2>/dev/null || true

echo "${marker}_END"
`;
  }

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

  if (startIdx === -1 || endIdx === -1) {
    return NextResponse.json({ success: false, error: "Test script did not complete. Check cluster connectivity." });
  }

  const body_output = full.slice(startIdx + `${marker}_START`.length, endIdx).replace(/\r/g, "").trim();
  const lines = body_output.split("\n").filter(Boolean);

  if (lines[0] === "RESULT_OK") {
    return NextResponse.json({
      success: true,
      message: type === "nfs"
        ? `NFS export ${nfsServer}:${nfsPath} is accessible`
        : `S3 bucket "${s3Bucket}" is accessible`,
    });
  }

  if (lines[0] === "RESULT_FAIL") {
    const detail = lines.slice(1).join("\n");
    return NextResponse.json({
      success: false,
      error: detail || "Test failed",
    });
  }

  return NextResponse.json({
    success: false,
    error: `Unexpected output:\n${body_output.slice(0, 500)}`,
  });
}
