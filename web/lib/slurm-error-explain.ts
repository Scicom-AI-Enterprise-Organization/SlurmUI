/**
 * Best-effort plain-English explanations for common Slurm / GPU / job
 * failure patterns. Pure client-safe — no network, no Node-only APIs.
 *
 * The matchers run greedily across the job's stderr + tail of stdout,
 * plus the optional Slurm-side `reason` and `exit_code`. Each match
 * yields a human-readable summary and a concrete next step. Matchers
 * are ordered roughly by specificity so the most actionable hint sits
 * first when multiple fire.
 */

export interface ExplainMatch {
  id: string;
  summary: string;
  suggestion: string;
  // Snippet of source text that triggered the match — useful for
  // "click to highlight in stderr" if we want that later.
  evidence: string;
  // Severity drives badge color. "fix" = user can/should change something
  // about their submission; "ops" = cluster operator needs to act.
  kind: "fix" | "ops";
}

interface Pattern {
  id: string;
  // Either a regex tested against the haystack, or a function for cases
  // where multiple signals combine (exit code + reason, etc).
  test: (haystack: string, ctx: ExplainContext) => RegExpMatchArray | null | boolean;
  summary: string;
  suggestion: string;
  kind: ExplainMatch["kind"];
}

export interface ExplainContext {
  reason?: string | null;
  exitCode?: number | null;
  status?: string | null;
}

const PATTERNS: Pattern[] = [
  // ---------- Slurm-imposed limits ----------
  {
    id: "time-limit",
    test: (h) => h.match(/(DUE TO TIME LIMIT|TimeLimit|JOB \d+ ON \S+ CANCELLED AT .+ DUE TO TIME LIMIT)/i),
    summary: "Job hit its walltime limit and was killed by Slurm.",
    suggestion: "Increase #SBATCH --time (e.g. --time=12:00:00) or break the work into smaller jobs.",
    kind: "fix",
  },
  {
    id: "oom-cgroup",
    test: (h) => h.match(/(oom_kill event|Out of memory: Killed process|cgroup out-of-memory|memory cgroup out of memory)/i),
    summary: "Job was killed because it ran out of memory (cgroup OOM).",
    suggestion: "Bump #SBATCH --mem (host RAM) or --mem-per-cpu. For DataLoader OOM, reduce batch size or num_workers.",
    kind: "fix",
  },
  {
    id: "cuda-oom",
    test: (h) => h.match(/(CUDA out of memory|CUBLAS_STATUS_ALLOC_FAILED|cudaErrorMemoryAllocation|torch\.cuda\.OutOfMemoryError)/i),
    summary: "GPU ran out of memory.",
    suggestion: "Reduce batch size, enable gradient checkpointing / activation offload, or request more (or larger) GPUs with --gres=gpu:N.",
    kind: "fix",
  },
  {
    id: "node-failure",
    test: (h) => h.match(/(NODE_FAIL|Node failure|due to node failure|node \S+ failed|NODE FAILURE)/i),
    summary: "A node went unresponsive mid-job; Slurm requeued / killed it.",
    suggestion: "Re-submit. If the same node keeps failing, run Diagnose on it from the Nodes tab and consider scontrol update NodeName=… State=DRAIN.",
    kind: "ops",
  },

  // ---------- NVIDIA XID errors ----------
  {
    id: "xid-79",
    test: (h) => h.match(/Xid.*\b79\b|GPU has fallen off the bus|XID 79/i),
    summary: "XID 79 — GPU fell off the PCIe bus. Almost always a power or thermal hardware fault.",
    suggestion: "Reset the node (cold reboot if power-cycle alone doesn't help), check PSU and chassis cooling. Drain the node until verified.",
    kind: "ops",
  },
  {
    id: "xid-mem-ecc",
    test: (h) => h.match(/Xid.*\b(48|63|64|92|94|95)\b/i),
    summary: "GPU memory ECC error (XID 48/63/64/92/94/95).",
    suggestion: "Run nvidia-smi -q -d ECC to confirm. Drain the node, swap the GPU if errors persist; transient ones can sometimes be cleared with a node reboot.",
    kind: "ops",
  },
  {
    id: "xid-clocks",
    test: (h) => h.match(/Xid.*\b(31|32)\b/i),
    summary: "GPU clocking/MMU error (XID 31/32). Often follows a CUDA illegal address.",
    suggestion: "Look for a buggy kernel (illegal memory access, out-of-bounds index). If it reproduces on multiple GPUs, fix the code; if isolated to one card, drain.",
    kind: "fix",
  },

  // ---------- Slurm scheduling / config ----------
  {
    id: "partition-down",
    test: (h) => h.match(/(Requested partition configuration not available|Requested node configuration is not available|requested partition is currently inactive)/i),
    summary: "No node currently satisfies what you asked for in this partition.",
    suggestion: "Check sinfo for available state. Lower --gres=gpu:N / --cpus-per-task / --mem, or pick a partition that has matching nodes.",
    kind: "fix",
  },
  {
    id: "qos-limit",
    test: (h) => h.match(/(QOSMaxJobsPerUserLimit|QOSMaxSubmitJobPerUserLimit|QOSMaxWallDurationPerJobLimit|InvalidQOS|qos.*invalid)/i),
    summary: "QoS limit hit (per-user job count, submit count, or walltime).",
    suggestion: "Wait for current jobs to finish, or ask an admin to bump MaxJobsPU/MaxSubmitPU/MaxWall on this QoS in the QoS tab.",
    kind: "fix",
  },
  {
    id: "assoc-limit",
    test: (h) => h.match(/(AssocMaxJobsLimit|AssocMaxSubmitJobLimit|AssocGrpCpuLimit|AssocGrpJobsLimit|invalid account)/i),
    summary: "Account/association limit reached or account is invalid.",
    suggestion: "Verify with sacctmgr show user $USER; admin can adjust account limits in the Users tab → Account tree.",
    kind: "fix",
  },
  {
    id: "munge",
    test: (h) => h.match(/(Munged|munge.*credential|Invalid authentication credential|munge.*expired)/i),
    summary: "Munge auth failed between nodes — clocks skewed or munge.key out of sync.",
    suggestion: "Sync time (chrony) and copy /etc/munge/munge.key across all nodes, then systemctl restart munge slurmd. The Nodes tab Diagnose button checks both.",
    kind: "ops",
  },

  // ---------- Storage / IO ----------
  {
    id: "disk-full",
    test: (h) => h.match(/(No space left on device|disk full|Quota exceeded|Operation not permitted.*write)/i),
    summary: "Out of disk space (or NFS quota) on the working dir / output path.",
    suggestion: "df -h / quota -s. Clean up scratch, pick a different storage mount, or write to a larger volume.",
    kind: "fix",
  },
  {
    id: "nfs-stale",
    test: (h) => h.match(/(Stale file handle|stale NFS file handle|Input\/output error.*nfs)/i),
    summary: "NFS handle went stale — server restarted or unmount/remount mismatch.",
    suggestion: "Re-mount the NFS export on the worker (Storages tab → Re-deploy). Re-submit afterwards.",
    kind: "ops",
  },
  {
    id: "permission",
    test: (h) => h.match(/(Permission denied|EACCES|chmod.*Operation not permitted)/i),
    summary: "Permission denied accessing a file or directory.",
    suggestion: "Check the path's owner/mode (ls -la), and whether the user is provisioned on every worker (Users tab — look for the linux + slurm badge).",
    kind: "fix",
  },

  // ---------- Distributed / NCCL ----------
  {
    id: "nccl",
    test: (h) => h.match(/(NCCL.*error|NCCL WARN|ncclSystemError|ncclUnhandledCudaError|NCCL.*timeout)/i),
    summary: "NCCL failure (multi-GPU comm).",
    suggestion: "Set NCCL_DEBUG=INFO and re-run. Check NIC link with `ibstat`/`ip a`. For timeouts, bump NCCL_BLOCKING_WAIT=1 NCCL_ASYNC_ERROR_HANDLING=1 NCCL_TIMEOUT_S=… and verify all ranks can reach each other.",
    kind: "fix",
  },
  {
    id: "gloo-conn",
    test: (h) => h.match(/(gloo.*Connection refused|gloo.*timed out|Address already in use.*MASTER_PORT)/i),
    summary: "Distributed init via Gloo couldn't reach the master.",
    suggestion: "Make sure MASTER_ADDR resolves on every rank, MASTER_PORT is free, and the firewall allows it. The first node's hostname (head node) is usually the right MASTER_ADDR.",
    kind: "fix",
  },

  // ---------- Python / driver ----------
  {
    id: "module-not-found",
    test: (h) => h.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/),
    summary: "Python import failed — package isn't in the active venv.",
    suggestion: "Add it via the Python tab (Apply to Cluster) or pip install into your venv before sbatch.",
    kind: "fix",
  },
  {
    id: "driver-mismatch",
    test: (h) => h.match(/(Driver\/library version mismatch|CUDA driver version is insufficient|libnvidia-ml\.so:.*version)/i),
    summary: "CUDA toolkit installed in the venv doesn't match the host driver.",
    suggestion: "Either upgrade the NVIDIA driver on the node or install a torch build matching the driver (e.g. cu124 for driver 550+).",
    kind: "ops",
  },
  {
    id: "ssh-publickey",
    test: (h) => h.match(/Permission denied \(publickey\)/i),
    summary: "SSH from the controller to a worker (or node-to-node) was rejected.",
    suggestion: "Re-deploy the cluster's authorized_keys (Nodes tab → Re-deploy on the affected node), and verify Munge/SSH on both ends.",
    kind: "ops",
  },

  // ---------- Slurm Reason field (no haystack body, derived from ctx) ----------
  {
    id: "reason-resources",
    test: (_h, ctx) => /(^Resources$|Priority|JobHeldUser|JobHeldAdmin|Dependency|BeginTime)/i.test(ctx.reason ?? "") ? true : null,
    summary: "Pending in queue — job is waiting on the scheduler, not failed.",
    suggestion: "Reason field tells you why: Resources = no node fits; Priority = queue order; Dependency = blocked by another job; JobHeldUser/Admin = needs scontrol release.",
    kind: "fix",
  },
];

/**
 * Run every pattern against the combined haystack and return the matches
 * (deduped by id). The result is ordered by pattern declaration order so
 * the more specific "fix" hints sit above generic "ops" ones.
 */
export function explainSlurmError(
  haystacks: Array<string | null | undefined>,
  ctx: ExplainContext = {},
): ExplainMatch[] {
  const haystack = haystacks.filter(Boolean).join("\n").slice(-50_000); // keep matching bounded
  const out: ExplainMatch[] = [];
  const seen = new Set<string>();
  for (const p of PATTERNS) {
    if (seen.has(p.id)) continue;
    const m = p.test(haystack, ctx);
    if (!m) continue;
    let evidence = "";
    if (typeof m === "object" && m !== null && "0" in m) {
      evidence = (m as RegExpMatchArray)[0].slice(0, 200);
    }
    out.push({
      id: p.id,
      summary: p.summary,
      suggestion: p.suggestion,
      evidence,
      kind: p.kind,
    });
    seen.add(p.id);
  }
  return out;
}
