import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams { params: Promise<{ id: string; jobId: string }> }

interface ProcInfo { pid: number; cpu: number; rss: number; comm: string }
interface GpuInfo {
  index: number;
  uuid: string;
  name: string;
  utilization: number;     // 0-100
  memoryUsedMB: number;
  memoryTotalMB: number;
  pids: number[];
}
interface NodeUsage {
  hostname: string;
  reachable: boolean;
  pids: number[];
  totalCpuPercent: number;     // sum of %CPU across job pids
  totalMemoryMB: number;       // sum of RSS across job pids
  cpuCount: number;            // cores on node
  memoryTotalMB: number;       // total node memory
  loadAvg1: number;
  processes: ProcInfo[];
  gpus: GpuInfo[];
  error?: string;
}

/** GET live CPU/RAM/GPU usage for a RUNNING job. Samples every call. */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id, jobId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.clusterId !== id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if ((session.user as any).role !== "ADMIN" && job.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!job.slurmJobId || job.status !== "RUNNING") {
    return NextResponse.json({ nodes: [], note: "Job not running" });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey || cluster.connectionMode !== "SSH") {
    return NextResponse.json({ nodes: [], note: "Not available for this cluster" });
  }

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const hosts = (config.slurm_hosts_entries ?? []) as Array<{ hostname: string; ip: string; user?: string; port?: number }>;
  const defaultUser = cluster.sshUser;

  // Bash lookup table: hostname -> "user|ip|port". Falls back to hostname as target.
  const hostMapLines = hosts.map((h) =>
    `HOSTMAP["${h.hostname}"]="${(h.user || defaultUser).replace(/"/g, "")}|${h.ip}|${h.port || 22}"`
  ).join("\n");

  const script = `#!/bin/bash
set +e
JOBID=${job.slurmJobId}

declare -A HOSTMAP
${hostMapLines}

NODES=$(scontrol show job $JOBID 2>/dev/null | grep -oP '(?<![A-Za-z]) NodeList=\\K[^ \\n]+' | head -1)
if [ -z "$NODES" ]; then
  NODES=$(scontrol show job $JOBID 2>/dev/null | awk '/^ *NodeList=/ {sub(/^ *NodeList=/,"",$1); print $1; exit} { for(i=1;i<=NF;i++){ if($i ~ /^NodeList=/){ sub(/^NodeList=/,"",$i); print $i; exit } } }')
fi
if [ -z "$NODES" ] || [ "$NODES" = "(null)" ]; then
  echo "__NO_NODES__"
  echo "__DEBUG_SCONTROL__"
  scontrol show job $JOBID 2>&1 | head -30
  exit 0
fi
EXPANDED=$(scontrol show hostnames "$NODES" 2>/dev/null)
echo "__AURA_USAGE_START__"
for NODE in $EXPANDED; do
  echo "__NODE__=$NODE"
  ENTRY="\${HOSTMAP[$NODE]}"
  if [ -n "$ENTRY" ]; then
    SU=$(echo "$ENTRY" | cut -d'|' -f1)
    SI=$(echo "$ENTRY" | cut -d'|' -f2)
    SP=$(echo "$ENTRY" | cut -d'|' -f3)
  else
    SU="${defaultUser}"; SI="$NODE"; SP="22"
  fi
  echo "__SSH_TARGET__=$SU@$SI:$SP"
  # Capture outer-ssh stderr separately so we can surface exact reason
  # (permission denied / timeout / host key) when the inner command never
  # gets to run. The inner heredoc's own stdout/stderr is caught via the
  # tee+2>&1 below.
  SSH_ERR_FILE=$(mktemp /tmp/.aura-usage-ssherr.XXXXXX)
  # NOTE: no -n here. ssh -n redirects stdin from /dev/null, which would
  # silently discard the REMOTE_EOF heredoc and make bash -s exit with rc=0
  # and zero output — identical to a "no job pids, 0 mem, unreachable" row.
  timeout 8 ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 \\
    -p "$SP" "$SU@$SI" "bash -s" 2> "$SSH_ERR_FILE" << 'REMOTE_EOF'
set +e
JOBID=__JOBID_PLACEHOLDER__
# Collect pids for this job (cgroup-scoped via slurm). Fallback to scanning /proc.
PIDS=$(scontrol listpids $JOBID 2>/dev/null | awk 'NR>1 {print $1}' | sort -u)
if [ -z "$PIDS" ]; then
  PIDS=$(for p in /proc/[0-9]*; do
    pid=$(basename "$p")
    if grep -q "slurm/uid_.*/job_$JOBID" /proc/$pid/cgroup 2>/dev/null; then echo "$pid"; fi
  done)
fi

echo "__CPUCOUNT__=$(nproc)"
MEM_KB=$(awk '/MemTotal/ {print $2; exit}' /proc/meminfo)
echo "__MEMTOTAL_MB__=$((MEM_KB/1024))"
echo "__LOAD1__=$(awk '{print $1}' /proc/loadavg)"

echo "__PIDS_START__"
for pid in $PIDS; do echo "$pid"; done
echo "__PIDS_END__"

echo "__PROCS_START__"
if [ -n "$PIDS" ]; then
  ps -o pid=,pcpu=,rss=,comm= -p $(echo $PIDS | tr '\\n' ',' | sed 's/,$//') 2>/dev/null
fi
echo "__PROCS_END__"

echo "__GPU_START__"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null
  echo "__GPU_APPS__"
  nvidia-smi --query-compute-apps=pid,used_memory,gpu_uuid --format=csv,noheader,nounits 2>/dev/null
fi
echo "__GPU_END__"
REMOTE_EOF
  RC=$?
  # Always emit the stderr block when the ssh failed, even if empty — lets
  # the caller distinguish "ssh printed nothing" from "we didn't capture
  # the file at all". rc=124 usually means the timeout binary killed a hung connect.
  if [ $RC -ne 0 ]; then
    echo "__SSH_STDERR_START__"
    if [ -s "$SSH_ERR_FILE" ]; then
      head -c 2000 "$SSH_ERR_FILE"
      echo ""
    else
      case "$RC" in
        124) echo "ssh timed out after 8s connecting to $SU@$SI:$SP (no stderr captured — usually means unreachable host, firewall drop, or wrong IP)";;
        255) echo "ssh returned 255 with no stderr (connection closed by peer before banner; check whether sshd is up on $SI:$SP)";;
        *)   echo "ssh exited with rc=$RC (no stderr captured)";;
      esac
    fi
    echo "__SSH_STDERR_END__"
  fi
  rm -f "$SSH_ERR_FILE"
  echo "__NODE_RC__=$RC"
done
echo "__AURA_USAGE_END__"
`.replace("__JOBID_PLACEHOLDER__", String(job.slurmJobId));

  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => { if (!line.startsWith("[stderr]")) chunks.push(line); },
      onComplete: () => resolve(),
    });
  });

  const full = chunks.join("\n");
  if (full.includes("__NO_NODES__")) {
    const dbg = full.split("__DEBUG_SCONTROL__")[1]?.slice(0, 2000) ?? "";
    return NextResponse.json({ nodes: [], note: "No allocated nodes yet", debug: dbg });
  }
  const s = full.indexOf("__AURA_USAGE_START__");
  const e = full.indexOf("__AURA_USAGE_END__");
  if (s === -1 || e === -1) {
    return NextResponse.json({ nodes: [], note: "Failed to collect usage" });
  }
  const body = full.slice(s + "__AURA_USAGE_START__".length, e);

  const nodes: NodeUsage[] = [];
  const perNodeBlocks = body.split("__NODE__=").filter(Boolean);
  for (const block of perNodeBlocks) {
    const firstNl = block.indexOf("\n");
    const hostname = block.slice(0, firstNl).trim();
    if (!hostname) continue;
    const rest = block.slice(firstNl + 1);

    const reachable = /__CPUCOUNT__=/.test(rest);
    const cpuCount = parseInt(/__CPUCOUNT__=(\d+)/.exec(rest)?.[1] ?? "0", 10);
    const memoryTotalMB = parseInt(/__MEMTOTAL_MB__=(\d+)/.exec(rest)?.[1] ?? "0", 10);
    const loadAvg1 = parseFloat(/__LOAD1__=([\d.]+)/.exec(rest)?.[1] ?? "0");

    const pidsBody = rest.split("__PIDS_START__")[1]?.split("__PIDS_END__")[0] ?? "";
    const pids = pidsBody.split("\n").map((l) => parseInt(l.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);

    const procsBody = rest.split("__PROCS_START__")[1]?.split("__PROCS_END__")[0] ?? "";
    const processes: ProcInfo[] = procsBody.split("\n").map((line) => {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!m) return null;
      return { pid: parseInt(m[1], 10), cpu: parseFloat(m[2]), rss: parseInt(m[3], 10), comm: m[4].trim() };
    }).filter((x): x is ProcInfo => x !== null);

    const totalCpuPercent = processes.reduce((a, p) => a + p.cpu, 0);
    const totalMemoryMB = Math.round(processes.reduce((a, p) => a + p.rss, 0) / 1024);

    const gpuBody = rest.split("__GPU_START__")[1]?.split("__GPU_END__")[0] ?? "";
    const [gpuListPart, gpuAppsPart] = gpuBody.split("__GPU_APPS__");
    const gpus: GpuInfo[] = (gpuListPart ?? "").split("\n").map((line): GpuInfo | null => {
      const parts = line.split(",").map((x) => x.trim());
      if (parts.length < 6) return null;
      return {
        index: parseInt(parts[0], 10),
        uuid: parts[1],
        name: parts[2],
        utilization: parseInt(parts[3], 10),
        memoryUsedMB: parseInt(parts[4], 10),
        memoryTotalMB: parseInt(parts[5], 10),
        pids: [] as number[],
      };
    }).filter((x): x is GpuInfo => x !== null && Number.isFinite(x.index));

    // Match compute apps to GPUs by uuid, keeping only pids owned by this job.
    const pidSet = new Set(pids);
    for (const line of (gpuAppsPart ?? "").split("\n")) {
      const parts = line.split(",").map((x) => x.trim());
      if (parts.length < 3) continue;
      const pid = parseInt(parts[0], 10);
      const uuid = parts[2];
      if (!pidSet.has(pid)) continue;
      const gpu = gpus.find((g) => g.uuid === uuid);
      if (gpu) gpu.pids.push(pid);
    }

    const sshTarget = /__SSH_TARGET__=([^\n]+)/.exec(rest)?.[1]?.trim();
    const nodeRc = /__NODE_RC__=(-?\d+)/.exec(rest)?.[1] ?? "?";
    // Prefer the dedicated outer-ssh stderr block — that's where "Permission
    // denied (publickey)" / "Connection timed out" / "Host key verification"
    // land. Falls back to the raw rest block if the marker isn't present.
    const sshStderr = rest.split("__SSH_STDERR_START__")[1]?.split("__SSH_STDERR_END__")[0]?.trim() ?? "";
    const fallbackBody = rest
      .replace(/__SSH_TARGET__=[^\n]+\n?/, "")
      .replace(/__SSH_STDERR_START__[\s\S]*?__SSH_STDERR_END__\n?/, "")
      .replace(/__NODE_RC__=[^\n]+\n?/, "")
      .trim();
    // When we truly have nothing, dump the entire raw block — no info is
    // worse than showing control markers. Capped so the card stays readable.
    const rawDump = rest.trim();
    const detail = sshStderr
      || fallbackBody
      || `rc=${nodeRc}, nothing on stdout/stderr. Raw block:\n${rawDump.slice(0, 800)}`;
    const error = reachable ? undefined : `SSH to ${sshTarget ?? hostname} (rc=${nodeRc}): ${detail.slice(0, 900)}`;

    nodes.push({
      hostname,
      reachable,
      error,
      pids,
      totalCpuPercent: Math.round(totalCpuPercent * 10) / 10,
      totalMemoryMB,
      cpuCount,
      memoryTotalMB,
      loadAvg1,
      processes: processes.sort((a, b) => b.cpu - a.cpu).slice(0, 20),
      gpus,
    });
  }

  return NextResponse.json({
    nodes,
    sampledAt: new Date().toISOString(),
  });
}
