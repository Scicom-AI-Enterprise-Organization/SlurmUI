/**
 * Post-bootstrap config seeding helpers.
 *
 * Bootstrap writes a working `slurm.conf` (NodeName + PartitionName), but
 * the UI reads from `cluster.config.slurm_partitions` to render the
 * Partitions tab and to populate the New Job form's partition dropdown.
 * Without these mirrored entries the user lands on "no default partition"
 * even though slurm itself has one. Call this once after a successful
 * bootstrap.
 */
import { prisma } from "@/lib/prisma";
import { sshExecScript, type SshTarget } from "@/lib/ssh-exec";
import { appendTaskLog } from "@/lib/task-log";

interface SlurmPartition {
  name: string;
  default?: boolean;
  max_time?: string;
}

/**
 * If `cluster.config.slurm_partitions` is empty, seed it with the same
 * default partition the slurm.conf template wrote (`main`, default,
 * MaxTime=INFINITE). Returns `true` when it actually wrote, `false` when
 * the field was already populated.
 */
export async function seedDefaultPartition(clusterId: string): Promise<boolean> {
  const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } });
  if (!cluster) return false;
  const cfg = (cluster.config ?? {}) as Record<string, unknown>;
  const existing = (cfg.slurm_partitions ?? []) as SlurmPartition[];
  if (Array.isArray(existing) && existing.length > 0) return false;

  cfg.slurm_partitions = [
    {
      name: "main",
      // Slurm accepts `Nodes=ALL` as a wildcard meaning "every node
      // configured in this slurm.conf". Required so a re-bootstrap that
      // reads this seed back into the template doesn't fail on a missing
      // `partition.nodes` attribute (the template does
      // `partition.nodes | join(',')`). Admins can change this in the
      // Partitions tab once they have real node groupings.
      nodes: "ALL",
      default: true,
      max_time: "INFINITE",
    },
  ];
  await prisma.cluster.update({
    where: { id: clusterId },
    data: { config: cfg as never },
  });
  return true;
}

export interface BootstrapNodeSeed {
  hostname: string;
  cpus: number;
  sockets: number;
  cores: number;
  threads: number;
  memMb: number;
  gpus: number;
  ip: string;
}

/**
 * After bootstrap (or instant-pod finalize) succeeds, probe the controller's
 * hardware and seed a proper entry in cluster.config.slurm_nodes +
 * slurm_hosts_entries for it. This mirrors what Add-Node does for workers — so
 * the controller is already a fully-tracked node and the user doesn't need to
 * Delete + Re-Add it to get Edit / Memory / CPU stats right.
 *
 * Extracted from app/api/clusters/[id]/bootstrap/route.ts so both the apt
 * bootstrap path AND the RunPod instant-cluster finalize step can reuse it
 * (Next App-Router route files can't cleanly export non-handler helpers).
 */
export async function seedControllerAsNode(args: {
  clusterId: string;
  taskId: string;
  sshTarget: SshTarget;
}): Promise<BootstrapNodeSeed | undefined> {
  const { clusterId, taskId, sshTarget } = args;
  if (!sshTarget.privateKey) return;

  // Re-read the cluster so we don't clobber concurrent config edits.
  const fresh = await prisma.cluster.findUnique({ where: { id: clusterId } });
  if (!fresh) return;
  const cfg = (fresh.config ?? {}) as Record<string, unknown>;
  const hosts = (cfg.slurm_hosts_entries ?? []) as Array<Record<string, unknown>>;
  const nodes = (cfg.slurm_nodes ?? []) as Array<Record<string, unknown>>;
  // If the user (or a previous bootstrap) already seeded something, don't overwrite.
  if (nodes.length > 0) {
    await appendTaskLog(taskId, `[aura] Controller auto-seed skipped — cluster already has ${nodes.length} node(s) configured.`);
    return;
  }

  // Probe the controller for its real hw: hostname, cpus, sockets, cores,
  // threads, memory, and an Nvidia GPU count (best-effort).
  const MARKER = `__SEED_${Date.now()}__`;
  const probe = `
echo "${MARKER}_START"
echo "hostname=$(hostname)"
echo "cpus=$(nproc --all)"
LSCPU=$(lscpu 2>/dev/null)
echo "sockets=$(echo "$LSCPU" | awk -F: '/^Socket\\(s\\):/ {gsub(/ /,"",$2); print $2}')"
echo "cores_per_socket=$(echo "$LSCPU" | awk -F: '/^Core\\(s\\) per socket:/ {gsub(/ /,"",$2); print $2}')"
echo "threads_per_core=$(echo "$LSCPU" | awk -F: '/^Thread\\(s\\) per core:/ {gsub(/ /,"",$2); print $2}')"
echo "memory_mb=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
echo "gpus=$(command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L 2>/dev/null | wc -l || echo 0)"
echo "${MARKER}_END"
`;
  // Probe via SSH. Capture BOTH stdout AND stderr — dropping stderr would
  // make any SSH-side error ("Permission denied", "Host key verification
  // failed", "Connection timed out") invisible, silently leaving the
  // controller unseeded and breaking every downstream step.
  const chunks: string[] = [];
  const errChunks: string[] = [];
  let probeOk = false;
  await new Promise<void>((resolve) => {
    sshExecScript(sshTarget, probe, {
      onStream: (line) => {
        if (line.startsWith("[stderr]")) errChunks.push(line.slice(9));
        else chunks.push(line);
      },
      onComplete: (ok) => { probeOk = ok; resolve(); },
    });
  });
  const blob = chunks.join("\n");
  const s = blob.indexOf(`${MARKER}_START`);
  const e = blob.indexOf(`${MARKER}_END`);
  if (s === -1 || e === -1) {
    await appendTaskLog(taskId, "[aura] Controller auto-seed skipped — could not probe hardware.");
    await appendTaskLog(taskId, `[aura] seedControllerAsNode: probeOk=${probeOk} stdout_lines=${chunks.length} stderr_lines=${errChunks.length}`);
    if (chunks.length > 0) {
      await appendTaskLog(taskId, `[aura] seedControllerAsNode stdout tail: ${chunks.slice(-10).join(" | ")}`);
    }
    if (errChunks.length > 0) {
      await appendTaskLog(taskId, `[aura] seedControllerAsNode stderr tail: ${errChunks.slice(-10).join(" | ")}`);
    }
    return;
  }
  const body = blob.slice(s + MARKER.length + 6, e);
  const kv: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^([a-z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }

  const hostname = kv.hostname || sshTarget.host;
  const cpus = parseInt(kv.cpus, 10) || 1;
  const sockets = parseInt(kv.sockets, 10) || 1;
  const cores = parseInt(kv.cores_per_socket, 10) || cpus;
  const threads = parseInt(kv.threads_per_core, 10) || 1;
  const rawMemMb = parseInt(kv.memory_mb, 10) || 1024;
  // Subtract a small safety margin from MemTotal before writing it to
  // slurm.conf — slurmd reports `reported = MemTotal/1024` on registration and
  // slurmctld rejects with INVAL if reported < configured. /proc/meminfo can
  // drift a few MB between our probe and slurmd's registration.
  const memMargin = Math.max(64, Math.min(256, Math.floor(rawMemMb * 0.01)));
  const memMb = Math.max(512, rawMemMb - memMargin);
  const gpus = parseInt(kv.gpus, 10) || 0;

  hosts.push({
    hostname,
    ip: sshTarget.host,
    user: sshTarget.user,
    port: sshTarget.port,
  });
  nodes.push({
    expression: hostname,
    ip: sshTarget.host,
    ssh_user: sshTarget.user,
    ssh_port: sshTarget.port,
    cpus,
    gpus,
    memory_mb: memMb,
    sockets,
    cores_per_socket: cores,
    threads_per_core: threads,
    role: "controller",
  });

  await prisma.cluster.update({
    where: { id: clusterId },
    data: {
      config: {
        ...cfg,
        slurm_hosts_entries: hosts,
        slurm_nodes: nodes,
      } as never,
    },
  });

  await appendTaskLog(
    taskId,
    `[aura] Controller auto-seeded as node "${hostname}": ${cpus} CPU / ${sockets}S${cores}C${threads}T / ${memMb} MB / ${gpus} GPU`,
  );

  return { hostname, cpus, sockets, cores, threads, memMb, gpus, ip: sshTarget.host };
}
