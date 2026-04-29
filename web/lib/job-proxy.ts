/**
 * Resolve "which IP is this Slurm job running on" so the web server can
 * directly proxy HTTP+WebSocket traffic to <jobNode>:<proxyPort>.
 *
 * The lookup is two stages:
 *   1) ssh controller → squeue -h -j <id> -o "%N" → scontrol show hostnames
 *      → list of hostnames the job is currently allocated.
 *   2) Map first hostname → IP via cluster.config.slurm_hosts_entries.
 *      Falls back to using the hostname itself when it's already an
 *      IP-literal or when the controller has DNS that the web server
 *      shares.
 *
 * The result is cached per-jobId for `CACHE_TTL_MS` (default 30s) so a
 * stream of HTTP/WS requests through the proxy doesn't trigger an SSH
 * round-trip per packet. Cache is invalidated when the job's status moves
 * away from RUNNING (handled by callers reading job.status).
 */
import { prisma } from "./prisma";
import { sshExecSimple, getClusterSshTarget } from "./ssh-exec";

interface HostEntry { hostname: string; ip: string }

interface ResolvedNode {
  hostname: string;
  ip: string;
  proxyPort: number;
}

interface CacheEntry {
  resolved: ResolvedNode;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

const looksLikeIp = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":");

/**
 * Resolve the (hostname, ip) the job runs on plus the saved proxyPort.
 * Returns null with a `reason` string when resolution can't proceed
 * (job not running, no proxy configured, no nodelist yet, etc.).
 */
export async function resolveJobProxyTarget(
  clusterId: string,
  jobId: string,
): Promise<{ ok: true; node: ResolvedNode } | { ok: false; status: number; reason: string }> {
  // Cheap path: hit the cache first.
  const cached = cache.get(jobId);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, node: cached.resolved };
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.clusterId !== clusterId) {
    return { ok: false, status: 404, reason: "Job not found" };
  }
  if (!job.proxyPort) {
    return { ok: false, status: 412, reason: "No proxy port configured for this job" };
  }
  if (job.status !== "RUNNING") {
    return { ok: false, status: 409, reason: `Job is ${job.status}, can't proxy` };
  }
  if (!job.slurmJobId) {
    return { ok: false, status: 409, reason: "Job has no Slurm id yet" };
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id: clusterId },
    include: { sshKey: true },
  });
  if (!cluster || !cluster.sshKey || cluster.connectionMode !== "SSH") {
    return { ok: false, status: 412, reason: "Cluster is not in SSH mode" };
  }
  const target = await getClusterSshTarget(clusterId);
  if (!target) return { ok: false, status: 412, reason: "No SSH target" };
  const tgt = { ...target, bastion: cluster.sshBastion };

  // Resolve the nodelist via the controller. We pick the first host the
  // job lands on — for multi-node jobs, the proxy semantics are "talk to
  // the head node"; users running clustered services should expose the
  // service on the head and let it broker. We can revisit if we hit a
  // real use-case for round-robin or per-rank routing.
  const cmd = `RAW=$(squeue -h -j "${job.slurmJobId}" -o "%N" 2>/dev/null)
if [ -z "$RAW" ] || [ "$RAW" = "(null)" ]; then echo "__NO_NODES__"; exit 0; fi
scontrol show hostnames "$RAW" 2>/dev/null | head -1`;
  const r = await sshExecSimple(tgt, cmd);
  if (!r.success) {
    return { ok: false, status: 502, reason: r.stderr || "SSH probe failed" };
  }
  if (r.stdout.includes("__NO_NODES__")) {
    return { ok: false, status: 409, reason: "Job has no nodelist yet — Slurm hasn't placed it" };
  }
  const hostname = r.stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean)[0];
  if (!hostname) {
    return { ok: false, status: 502, reason: "Couldn't parse hostname from controller" };
  }

  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const entry = hostsEntries.find((h) => h.hostname === hostname);
  // If we don't have an explicit mapping, fall back to the hostname itself.
  // That works when (a) it's already an IP literal or (b) the web server
  // shares DNS with the controller for the cluster's internal hostnames.
  const ip = entry?.ip || hostname;
  if (!ip) {
    return { ok: false, status: 502, reason: `No IP mapping for host ${hostname}` };
  }
  if (!looksLikeIp(ip) && !entry) {
    // Heads-up: we're handing a non-IP, non-mapped host straight to net.connect.
    // It'll work if DNS resolves; otherwise the caller will get ECONNREFUSED /
    // ENOTFOUND and we'll surface that as 502. Keep going.
  }

  const resolved: ResolvedNode = { hostname, ip, proxyPort: job.proxyPort };
  cache.set(jobId, { resolved, expiresAt: Date.now() + CACHE_TTL_MS });
  return { ok: true, node: resolved };
}

export function invalidateJobProxyCache(jobId: string) {
  cache.delete(jobId);
}
