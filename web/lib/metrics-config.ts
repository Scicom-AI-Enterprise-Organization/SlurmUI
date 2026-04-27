/**
 * Per-cluster metrics configuration.
 *
 * Stored under cluster.config.metrics so we don't need a schema migration.
 * The metrics stack (Prometheus + Grafana) runs as docker containers on the
 * controller; per-node exporters (dcgm-exporter / nvidia_gpu_exporter +
 * node_exporter) run on each worker.
 */

export type ExporterMode = "auto" | "dcgm" | "nvidia_smi";

export interface MetricsNodeState {
  // Last-known exporter mode actually installed on the node.
  exporter?: "dcgm" | "nvidia_smi";
  installedAt?: string;
  // Whether this node should be included in the Prometheus scrape config.
  // Default: true once installed.
  scrape?: boolean;
}

export interface MetricsConfig {
  enabled: boolean;
  // Default exporter mode for new installs. "auto" lets the node decide based
  // on whether it's running inside a container (nvidia_smi) or bare-metal
  // / VM (dcgm). Mirrors the upstream gpu-metrics-exporter logic.
  exporterMode: ExporterMode;
  prometheusPort: number;
  grafanaPort: number;
  // Prometheus retention, e.g. "15d", "30d", "90d".
  retention: string;
  // Hostname of the node that runs the Prometheus + Grafana stack. Special
  // value "controller" (or unset) uses the cluster controller. Otherwise
  // must match a slurm_hosts_entries[].hostname so we can resolve its IP
  // and SSH credentials.
  stackHost?: string;
  // Host filesystem path the prometheus + grafana systemd services write
  // their data into. Two sub-dirs are created: <stackDataPath>/prometheus
  // and <stackDataPath>/grafana. Unset = /var/lib/aura-metrics on the
  // stack host.
  stackDataPath?: string;
  // Per-node state, keyed by Slurm node name (matches `sinfo` output and
  // slurm_hosts_entries[].hostname). The IP comes from slurm_hosts_entries.
  nodes: Record<string, MetricsNodeState>;
  // Generated once at deploy time. Shown to admin via UI; not exposed to
  // non-admins. Reset on re-deploy.
  grafanaAdminPassword?: string;
  grafanaDeployedAt?: string;
  // Absolute URL baked into grafana.ini's `root_url` at deploy time.
  // Grafana resolves this once on startup and uses it to build every
  // absolute link it emits — drift between this value and the user's
  // current browser origin (e.g. you deployed from dev, then opened in
  // prod) breaks asset loading. The UI compares this against the live
  // origin and surfaces a "needs redeploy" warning when they diverge.
  grafanaRootUrl?: string;
}

export const METRICS_DEFAULTS: MetricsConfig = {
  enabled: false,
  exporterMode: "auto",
  prometheusPort: 9090,
  grafanaPort: 3000,
  retention: "15d",
  stackHost: "controller",
  nodes: {},
};

export function readMetricsConfig(clusterConfig: unknown): MetricsConfig {
  const cfg = (clusterConfig ?? {}) as Record<string, unknown>;
  const stored = (cfg.metrics ?? {}) as Partial<MetricsConfig>;
  return {
    ...METRICS_DEFAULTS,
    ...stored,
    nodes: stored.nodes ?? {},
  };
}

export function mergeMetricsConfig(
  clusterConfig: unknown,
  patch: Partial<MetricsConfig>,
): Record<string, unknown> {
  const cfg = (clusterConfig ?? {}) as Record<string, unknown>;
  const current = readMetricsConfig(cfg);
  const merged: MetricsConfig = {
    ...current,
    ...patch,
    nodes: patch.nodes ? { ...current.nodes, ...patch.nodes } : current.nodes,
  };
  return { ...cfg, metrics: merged };
}

interface HostEntry {
  hostname: string;
  ip: string;
  user?: string;
  port?: number;
}

/**
 * Resolve scrape targets for Prometheus. Reads slurm_hosts_entries from the
 * cluster config (the same list other tabs use) and intersects with the
 * per-node `scrape` flag. When a node has never been installed it is
 * excluded.
 */
export function resolveScrapeTargets(
  clusterConfig: unknown,
  metrics: MetricsConfig,
): Array<{ hostname: string; ip: string }> {
  const cfg = (clusterConfig ?? {}) as Record<string, unknown>;
  const hostsEntries = (cfg.slurm_hosts_entries ?? []) as HostEntry[];
  return hostsEntries
    .filter((h) => {
      const state = metrics.nodes[h.hostname];
      if (!state) return false;
      return state.scrape !== false;
    })
    .map((h) => ({ hostname: h.hostname, ip: h.ip }));
}

export interface StackHostResolved {
  // Display label, what we put in the UI.
  hostname: string;
  // The IP/host the controller can reach the stack on.
  ip: string;
  // True when the stack runs on the controller itself (no inner SSH hop).
  isController: boolean;
  // SSH credentials for the inner hop when isController=false.
  user?: string;
  port?: number;
}

/**
 * Resolve where the metrics stack should live for a given cluster.
 * Falls back to the controller when stackHost is unset, "controller",
 * or doesn't match any known worker entry.
 */
export function resolveStackHost(
  clusterControllerHost: string,
  clusterConfig: unknown,
  metrics: MetricsConfig,
): StackHostResolved {
  const wanted = (metrics.stackHost ?? "controller").trim();
  if (!wanted || wanted === "controller" || wanted === clusterControllerHost) {
    return {
      hostname: clusterControllerHost,
      ip: clusterControllerHost,
      isController: true,
    };
  }
  const cfg = (clusterConfig ?? {}) as Record<string, unknown>;
  const hostsEntries = (cfg.slurm_hosts_entries ?? []) as HostEntry[];
  const match = hostsEntries.find((h) => h.hostname === wanted);
  if (!match) {
    return {
      hostname: clusterControllerHost,
      ip: clusterControllerHost,
      isController: true,
    };
  }
  return {
    hostname: match.hostname,
    ip: match.ip,
    isController: false,
    user: match.user,
    port: match.port,
  };
}

/**
 * List of legal `stackHost` values: the literal "controller" plus every
 * worker hostname that also has a metrics exporter installed (otherwise the
 * dropdown would let admins pick a node we can't actually reach via SSH-
 * from-controller).
 */
export function listStackHostCandidates(
  clusterConfig: unknown,
): string[] {
  const cfg = (clusterConfig ?? {}) as Record<string, unknown>;
  const hostsEntries = (cfg.slurm_hosts_entries ?? []) as HostEntry[];
  return ["controller", ...hostsEntries.map((h) => h.hostname)];
}
