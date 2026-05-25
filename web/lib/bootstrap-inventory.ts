/**
 * Shared helper for building the ansible inventory used by both the
 * UI-facing bootstrap route (`/api/clusters/[id]/bootstrap`) and the
 * Bearer-auth/synchronous variant (`/api/v1/clusters/[id]/bootstrap`).
 *
 * Pulled into its own module because Next App-Router route files may
 * only export the HTTP-method handlers — any extra named export from a
 * `route.ts` breaks compilation.
 */

interface HostEntry {
  hostname: string;
  ip: string;
  port?: number;
  // role is populated by seedControllerAsNode / seedControllerInline. When
  // present and equal to "controller", the entry is the controller itself
  // and must never be rendered into [slurm_workers] — otherwise the worker
  // play loops back through ansible_host=<controller-loopback> trying to
  // ssh-to-self with whatever ip:port the entry was first saved with
  // (commonly "localhost":22, which then can't be reached from the web
  // container and the bootstrap fails at the worker `Gathering Facts`).
  role?: string;
  user?: string;
}

export interface ClusterSsh {
  host: string;
  user: string;
  port: number;
  sshKeyFile?: string;
  /**
   * Raw -o ProxyCommand to reach the controller (e.g.
   * `cloudflared access ssh --hostname %h`). When set, every
   * ansible_host line gets a matching ansible_ssh_common_args entry so
   * the underlying ssh client honours it. Without this, ansible bypasses
   * the cluster's ProxyCommand and tries to TCP-connect directly to
   * ansible_host — which fails ("Network unreachable") for tunnel-only
   * controllers like Cloudflare Tunnel-fronted hosts.
   */
  proxyCommand?: string | null;
}

export function buildInventory(clusterSsh: ClusterSsh, config: Record<string, unknown>): string {
  const controllerHost = config.slurm_controller_host as string;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  // controllerHost is usually an IP, but hostsEntries' hostname is the
  // logical Slurm node name (often different). Exclude workers whose IP OR
  // hostname matches the controller — otherwise a single-VM bootstrap loops
  // back to itself as a worker, which fails NFS self-mount.
  //
  // Also exclude entries flagged role="controller" (set by
  // seedControllerInline) AND any entry whose hostname matches a
  // controller-role node in slurm_nodes. seedControllerInline records the
  // hostname Ansible's `hostname` returns, which routinely differs from
  // controllerHost (e.g. "dsw-…" vs "8.222.165.68"). Without these guards
  // a stale localhost:22 entry from a previous bootstrap cycle leaks into
  // [slurm_workers] and the worker play fails with `Connection refused`
  // on localhost:22 from the web container.
  const slurmNodes = (config.slurm_nodes ?? []) as Array<{ expression?: string; role?: string }>;
  const controllerHostnames = new Set(
    slurmNodes.filter((n) => n.role === "controller").map((n) => n.expression).filter(Boolean) as string[],
  );
  const workerEntries = hostsEntries.filter(
    (h) =>
      h.role !== "controller" &&
      !controllerHostnames.has(h.hostname) &&
      h.hostname !== controllerHost &&
      h.ip !== controllerHost,
  );

  const keyArg = clusterSsh.sshKeyFile ? ` ansible_ssh_private_key_file=${clusterSsh.sshKeyFile}` : "";

  const proxyArg = clusterSsh.proxyCommand && clusterSsh.proxyCommand.trim()
    ? ` ansible_ssh_common_args='-o ProxyCommand="${clusterSsh.proxyCommand.replace(/'/g, "'\\''")}"'`
    : "";

  const controllerLine = `${controllerHost} ansible_host=${clusterSsh.host} ansible_user=${clusterSsh.user} ansible_port=${clusterSsh.port} ansible_python_interpreter=/usr/bin/python3${keyArg}${proxyArg}`;

  const workerLines = workerEntries
    .map((h) => {
      const user = (h as any).user || clusterSsh.user;
      const port = (h as any).port || 22;
      return `${h.hostname} ansible_host=${h.ip} ansible_user=${user} ansible_port=${port} ansible_python_interpreter=/usr/bin/python3${keyArg}${proxyArg}`;
    })
    .join("\n");

  return `[slurm_controllers]\n${controllerLine}\n\n[slurm_workers]\n${workerLines}\n`;
}
