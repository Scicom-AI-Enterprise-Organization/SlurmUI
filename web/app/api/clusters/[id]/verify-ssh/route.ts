import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExec } from "@/lib/ssh-exec";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/verify-ssh — verify SSH connectivity and gather system info
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
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }
  if (!cluster.sshKey) {
    return NextResponse.json({ error: "No SSH key assigned to this cluster." }, { status: 412 });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
  };

  const enc = new TextEncoder();
  let seq = 0;

  const verifyScript = `#!/bin/bash
set -euo pipefail

echo ""
echo "============================================"
echo "  SSH Connection Verified"
echo "============================================"
echo ""
echo "[1/3] System information"
echo "  Hostname:    $(hostname)"
echo "  OS:          $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '"' || uname -s)"
echo "  Kernel:      $(uname -r)"
echo "  Architecture: $(uname -m)"
echo "  CPU cores:   $(nproc 2>/dev/null || echo unknown)"
echo "  Memory:      $(free -h 2>/dev/null | awk '/^Mem:/{print $2}' || echo unknown)"
echo "  Uptime:      $(uptime -p 2>/dev/null || uptime)"
echo "  User:        $(whoami)"
echo ""

echo "[2/3] Checking Slurm installation..."
if command -v sinfo &>/dev/null; then
  echo "  sinfo:       $(which sinfo)"
  SLURM_VER=$(sinfo --version 2>/dev/null || echo "unknown")
  echo "  Version:     $SLURM_VER"
  echo ""
  echo "  Cluster status:"
  sinfo --noheader --format="    %-15P %-8a %-10l %-6D %N" 2>/dev/null || echo "    (could not query sinfo)"
else
  echo "  Slurm not found (sinfo not in PATH)"
  echo "  Slurm can be set up later via the cluster setup wizard"
fi
echo ""

echo "[3/3] Checking other tools..."
for cmd in sbatch squeue scancel scontrol python3 ansible-playbook; do
  if command -v $cmd &>/dev/null; then
    echo "  $cmd: $(which $cmd)"
  else
    echo "  $cmd: not found"
  fi
done
echo ""

echo "============================================"
echo "  Connection OK! Ready for cluster setup."
echo "============================================"
`;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };

      send({ type: "stream", line: `[ssh] Connecting to ${target.user}@${target.host}:${target.port}...`, seq: seq++ });

      const { proc } = sshExec(target, "bash -s", {
        onStream: (line, s) => {
          send({ type: "stream", line, seq: seq++ });
        },
        onComplete: async (success, payload) => {
          send({ type: "stream", line: "", seq: seq++ });
          if (success) {
            // Mark cluster as active for SSH mode
            await prisma.cluster.update({
              where: { id },
              data: { status: "ACTIVE" },
            });
            send({ type: "complete", success: true });
          } else {
            send({
              type: "complete",
              success: false,
              message: `SSH failed (exit code ${payload?.exitCode ?? "unknown"})`,
            });
          }
          controller.close();
        },
      });

      // Pipe the verify script to stdin
      proc.stdin!.write(verifyScript);
      proc.stdin!.end();
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
