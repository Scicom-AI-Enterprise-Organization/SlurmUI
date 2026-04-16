import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple } from "@/lib/ssh-exec";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/nodes/test-ssh
// SSHes into the CONTROLLER and from there tests connectivity to the worker node
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

  const { ip, user, port, detect } = await req.json();
  if (!ip) return NextResponse.json({ error: "ip is required" }, { status: 400 });

  const targetUser = user || "root";
  const targetPort = port || 22;
  const controllerTarget = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
  };

  if (detect) {
    // Pipe a detection script through the controller to the worker
    const result = await sshExecSimple(
      controllerTarget,
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${targetPort} ${targetUser}@${ip} bash << 'DETECT_EOF'
CPUS=$(nproc 2>/dev/null || echo 0)
MEM_KB=$(cat /proc/meminfo 2>/dev/null | head -1 | sed 's/[^0-9]//g' || echo 0)
GPUS=$(ls /dev/nvidia[0-9]* 2>/dev/null | wc -l || echo 0)
if [ "$GPUS" = "0" ]; then
  GPUS=$(nvidia-smi -L 2>/dev/null | wc -l || echo 0)
fi
echo "CPUS=$CPUS"
echo "MEM_KB=$MEM_KB"
echo "GPUS=$GPUS"
DETECT_EOF`
    );

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.stderr.trim() || "Detection failed" });
    }

    const lines = result.stdout.split("\n");
    let cpus = 0;
    let memoryGb = 0;
    let gpus = 0;

    for (const line of lines) {
      if (line.startsWith("CPUS=")) cpus = parseInt(line.split("=")[1]) || 0;
      if (line.startsWith("MEM_KB=")) memoryGb = Math.round((parseInt(line.split("=")[1]) || 0) / 1024 / 1024);
      if (line.startsWith("GPUS=")) gpus = parseInt(line.split("=")[1]) || 0;
    }

    return NextResponse.json({ success: true, cpus, memoryGb, gpus });
  }

  // Test: Aura → controller → worker
  const result = await sshExecSimple(
    controllerTarget,
    `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${targetPort} ${targetUser}@${ip} 'hostname && echo __SSH_OK__'`
  );

  if (result.success && result.stdout.includes("__SSH_OK__")) {
    const hostname = result.stdout.split("\n")[0]?.trim() ?? "";
    return NextResponse.json({ success: true, hostname });
  }

  const errorMsg = result.stderr
    .split("\n")
    .filter((l) => !l.startsWith("Warning: Permanently added"))
    .join("\n")
    .trim() || result.stdout.trim() || `Exit code ${result.exitCode}`;

  return NextResponse.json({ success: false, error: errorMsg });
}
