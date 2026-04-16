import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple } from "@/lib/ssh-exec";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * For bastion: encode a script as base64, send one command to decode+run+exit.
 * Returns stdout collected from the PTY session.
 */
function bastionExec(
  host: string, user: string, port: number, privateKey: string,
  script: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aura-btest-"));
    const keyPath = join(tmpDir, "ssh_key");
    writeFileSync(keyPath, privateKey, { mode: 0o600 });
    chmodSync(keyPath, 0o600);

    const b64 = Buffer.from(script).toString("base64");
    const remoteFile = "/tmp/.aura-test-$$.sh";
    const cmd = `echo '${b64}' | base64 -d > ${remoteFile} && bash ${remoteFile}; rm -f ${remoteFile}; exit\n`;

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const proc = spawn("ssh", [
      "-i", keyPath,
      "-p", String(port),
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=15",
      "-tt",
      `${user}@${host}`,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    setTimeout(() => { proc.stdin.write(cmd); }, 2000);

    proc.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString()));
    proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString()));

    const timeout = setTimeout(() => {
      proc.kill();
      rmSync(tmpDir, { recursive: true, force: true });
      resolve({ success: false, stdout: stdoutChunks.join(""), stderr: "Timeout" });
    }, 30000);

    proc.on("close", () => {
      clearTimeout(timeout);
      rmSync(tmpDir, { recursive: true, force: true });
      const stdout = stdoutChunks.join("").replace(/\r\n/g, "\n").replace(/\r/g, "");
      resolve({ success: true, stdout, stderr: stderrChunks.join("") });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      rmSync(tmpDir, { recursive: true, force: true });
      resolve({ success: false, stdout: "", stderr: err.message });
    });
  });
}

// POST /api/clusters/[id]/nodes/test-ssh
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

  if (cluster.sshBastion) {
    // Bastion mode: run test script through the bastion
    const testScript = detect
      ? `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${targetPort} ${targetUser}@${ip} bash << 'EOF'
CPUS=$(nproc 2>/dev/null || echo 0)
SOCKETS=$(lscpu 2>/dev/null | awk -F: '/^Socket/ {gsub(/ /,""); print $2; exit}' || echo 1)
CORES_PER_SOCKET=$(lscpu 2>/dev/null | awk -F: '/Core\\(s\\) per socket/ {gsub(/ /,""); print $2; exit}' || echo 1)
THREADS_PER_CORE=$(lscpu 2>/dev/null | awk -F: '/Thread\\(s\\) per core/ {gsub(/ /,""); print $2; exit}' || echo 1)
MEM_KB=$(cat /proc/meminfo 2>/dev/null | head -1 | sed 's/[^0-9]//g' || echo 0)
GPUS=$(ls /dev/nvidia[0-9]* 2>/dev/null | wc -l || echo 0)
if [ "$GPUS" = "0" ]; then GPUS=$(nvidia-smi -L 2>/dev/null | wc -l || echo 0); fi
echo "CPUS=$CPUS"
echo "SOCKETS=$SOCKETS"
echo "CORES_PER_SOCKET=$CORES_PER_SOCKET"
echo "THREADS_PER_CORE=$THREADS_PER_CORE"
echo "MEM_KB=$MEM_KB"
echo "GPUS=$GPUS"
echo "__DETECT_OK__"
EOF`
      : `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${targetPort} ${targetUser}@${ip} hostname && echo __SSH_OK__`;

    const result = await bastionExec(
      cluster.controllerHost, cluster.sshUser, cluster.sshPort,
      cluster.sshKey.privateKey, testScript,
    );

    const output = result.stdout;

    if (detect) {
      if (output.includes("__DETECT_OK__")) {
        const lines = output.split("\n");
        let cpus = 0, sockets = 1, coresPerSocket = 1, threadsPerCore = 1, memoryGb = 0, memoryMb = 0, gpus = 0;
        for (const line of lines) {
          if (line.startsWith("CPUS=")) cpus = parseInt(line.split("=")[1]) || 0;
          if (line.startsWith("SOCKETS=")) sockets = parseInt(line.split("=")[1]) || 1;
          if (line.startsWith("CORES_PER_SOCKET=")) coresPerSocket = parseInt(line.split("=")[1]) || 1;
          if (line.startsWith("THREADS_PER_CORE=")) threadsPerCore = parseInt(line.split("=")[1]) || 1;
          if (line.startsWith("MEM_KB=")) {
            const kb = parseInt(line.split("=")[1]) || 0;
            memoryMb = Math.round(kb / 1024);
            memoryGb = Math.round(kb / 1024 / 1024);
          }
          if (line.startsWith("GPUS=")) gpus = parseInt(line.split("=")[1]) || 0;
        }
        return NextResponse.json({ success: true, cpus, sockets, coresPerSocket, threadsPerCore, memoryGb, memoryMb, gpus });
      }
      return NextResponse.json({ success: false, error: "Detection failed" });
    }

    if (output.includes("__SSH_OK__")) {
      // Extract hostname: the line before __SSH_OK__
      const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
      const okIdx = lines.findIndex((l) => l.includes("__SSH_OK__"));
      const hostname = okIdx > 0 ? lines[okIdx - 1] : "";
      return NextResponse.json({ success: true, hostname });
    }

    const errorMsg = output.includes("Connection timed out") ? "Connection timed out"
      : output.includes("Connection refused") ? "Connection refused"
      : output.includes("Permission denied") ? "Permission denied"
      : "Cannot reach node from controller";
    return NextResponse.json({ success: false, error: errorMsg });
  }

  // Normal SSH mode: Aura → controller → worker
  const controllerTarget = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
  };

  if (detect) {
    const result = await sshExecSimple(
      controllerTarget,
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${targetPort} ${targetUser}@${ip} bash << 'DETECT_EOF'
CPUS=$(nproc 2>/dev/null || echo 0)
SOCKETS=$(lscpu 2>/dev/null | awk -F: '/^Socket/ {gsub(/ /,""); print $2; exit}' || echo 1)
CORES_PER_SOCKET=$(lscpu 2>/dev/null | awk -F: '/Core\\(s\\) per socket/ {gsub(/ /,""); print $2; exit}' || echo 1)
THREADS_PER_CORE=$(lscpu 2>/dev/null | awk -F: '/Thread\\(s\\) per core/ {gsub(/ /,""); print $2; exit}' || echo 1)
MEM_KB=$(cat /proc/meminfo 2>/dev/null | head -1 | sed 's/[^0-9]//g' || echo 0)
GPUS=$(ls /dev/nvidia[0-9]* 2>/dev/null | wc -l || echo 0)
if [ "$GPUS" = "0" ]; then
  GPUS=$(nvidia-smi -L 2>/dev/null | wc -l || echo 0)
fi
echo "CPUS=$CPUS"
echo "SOCKETS=$SOCKETS"
echo "CORES_PER_SOCKET=$CORES_PER_SOCKET"
echo "THREADS_PER_CORE=$THREADS_PER_CORE"
echo "MEM_KB=$MEM_KB"
echo "GPUS=$GPUS"
DETECT_EOF`
    );

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.stderr.trim() || "Detection failed" });
    }

    const lines = result.stdout.split("\n");
    let cpus = 0, sockets = 1, coresPerSocket = 1, threadsPerCore = 1, memoryGb = 0, memoryMb = 0, gpus = 0;
    for (const line of lines) {
      if (line.startsWith("CPUS=")) cpus = parseInt(line.split("=")[1]) || 0;
      if (line.startsWith("SOCKETS=")) sockets = parseInt(line.split("=")[1]) || 1;
      if (line.startsWith("CORES_PER_SOCKET=")) coresPerSocket = parseInt(line.split("=")[1]) || 1;
      if (line.startsWith("THREADS_PER_CORE=")) threadsPerCore = parseInt(line.split("=")[1]) || 1;
      if (line.startsWith("MEM_KB=")) {
        const kb = parseInt(line.split("=")[1]) || 0;
        memoryMb = Math.round(kb / 1024);
        memoryGb = Math.round(kb / 1024 / 1024);
      }
      if (line.startsWith("GPUS=")) gpus = parseInt(line.split("=")[1]) || 0;
    }

    return NextResponse.json({ success: true, cpus, sockets, coresPerSocket, threadsPerCore, memoryGb, memoryMb, gpus });
  }

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
