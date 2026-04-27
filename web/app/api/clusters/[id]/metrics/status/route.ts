import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple, getClusterSshTarget } from "@/lib/ssh-exec";
import { readMetricsConfig, resolveStackHost } from "@/lib/metrics-config";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface HostEntry {
  hostname: string;
  ip: string;
  user?: string;
  port?: number;
}

type Reachability = "up" | "loopback_only" | "down" | "no_gpu" | "unknown";

interface NodeStatus {
  hostname: string;
  ip: string;
  installed: boolean;
  exporter?: "dcgm" | "nvidia_smi";
  installedAt?: string;
  nodeExporter: Reachability;
  gpuExporter: Reachability;
}

/**
 * Probe one node's exporter ports. We do TWO probes per port:
 *   1. From the controller against <nodeIP>:port — what Prometheus will see
 *   2. From inside the node against 127.0.0.1:port — what's actually running
 *
 * If (1) fails but (2) succeeds, the exporter is bound to loopback only and
 * Prometheus won't be able to scrape it from a different host. We surface
 * that as "loopback_only" so the UI can warn instead of just showing red.
 */
async function probeNode(
  controllerTarget: Awaited<ReturnType<typeof getClusterSshTarget>>,
  bastionFlag: boolean,
  h: HostEntry,
): Promise<{ node: Reachability; gpu: Reachability }> {
  if (!controllerTarget) return { node: "down", gpu: "down" };
  const tgt = { ...controllerTarget, bastion: bastionFlag } as Parameters<typeof sshExecSimple>[0];
  const u = h.user || "root";
  const p = h.port || 22;
  const sshOpts = `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -p ${p}`;
  // Both probes piggy-back on a single ssh round-trip. The inner ssh into
  // the worker tests loopback; the outer curl from the controller tests
  // off-host reachability.
  const cmd = `printf 'NODE_EXT='; curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://${h.ip}:9100/metrics; printf '\\nGPU_EXT='; curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://${h.ip}:9400/metrics; printf '\\n'; ssh ${sshOpts} ${u}@${h.ip} "printf 'NODE_LO='; curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:9100/metrics; printf '\\nGPU_LO='; curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:9400/metrics; printf '\\n'" 2>/dev/null`;
  const r = await sshExecSimple(tgt, cmd);
  if (!r.success) return { node: "down", gpu: "down" };
  const code = (key: string) => {
    const m = r.stdout.match(new RegExp(`${key}=(\\d{3})`));
    return m?.[1] ?? "";
  };
  const classify = (ext: string, lo: string): Reachability => {
    if (ext === "200") return "up";
    if (lo === "200") return "loopback_only";
    return "down";
  };
  return {
    node: classify(code("NODE_EXT"), code("NODE_LO")),
    gpu: classify(code("GPU_EXT"), code("GPU_LO")),
  };
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
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

  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const metrics = readMetricsConfig(config);
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];

  const target = await getClusterSshTarget(id);
  if (!target) {
    return NextResponse.json(
      { error: "No SSH key configured", metrics, nodes: [] },
      { status: 412 },
    );
  }

  // Fan out probes in parallel — bounded by the controller's outbound
  // capacity, not ours, so even big clusters return in a few seconds.
  const nodes: NodeStatus[] = await Promise.all(
    hostsEntries.map(async (h): Promise<NodeStatus> => {
      const state = metrics.nodes[h.hostname];
      const probe = await probeNode(target, cluster.sshBastion, h);
      let gpu: NodeStatus["gpuExporter"];
      if (probe.gpu === "up" || probe.gpu === "loopback_only") gpu = probe.gpu;
      else if (state?.exporter) gpu = "down";
      else gpu = "unknown";
      return {
        hostname: h.hostname,
        ip: h.ip,
        installed: !!state,
        exporter: state?.exporter,
        installedAt: state?.installedAt,
        nodeExporter: probe.node,
        gpuExporter: gpu,
      };
    }),
  );

  // Stack health — probe whichever host runs the stack. We always SSH into
  // the controller and curl from there: if the stack lives on the controller,
  // we hit 127.0.0.1; otherwise we hit the worker's IP over the cluster's
  // private network.
  const promPort = metrics.prometheusPort;
  const grafanaPort = metrics.grafanaPort;
  const stack = resolveStackHost(cluster.controllerHost, config, metrics);
  const stackProbeIp = stack.isController ? "127.0.0.1" : stack.ip;
  const stackTarget = { ...target, bastion: cluster.sshBastion };
  const stackCmd = `printf 'PROM='; curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://${stackProbeIp}:${promPort}/-/ready; printf '\\nGRAF='; curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://${stackProbeIp}:${grafanaPort}/api/health; printf '\\n'`;
  const sr = await sshExecSimple(stackTarget, stackCmd);
  const promUp = /PROM=200/.test(sr.stdout);
  const grafUp = /GRAF=200/.test(sr.stdout);

  return NextResponse.json({
    metrics,
    nodes,
    stack: {
      host: stack.hostname,
      isController: stack.isController,
      prometheus: promUp ? "up" : "down",
      grafana: grafUp ? "up" : "down",
      grafanaDeployedAt: metrics.grafanaDeployedAt ?? null,
    },
  });
}
