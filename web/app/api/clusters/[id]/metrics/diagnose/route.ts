import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecSimple, getClusterSshTarget } from "@/lib/ssh-exec";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface HostEntry {
  hostname: string;
  ip: string;
  user?: string;
  port?: number;
}

/**
 * Read-only diagnostic for a single node's metrics endpoints. SSHes from
 * the controller, hops to the node, and prints what's listening on :9100
 * and :9400, the metric prefix detected, the relevant systemd / docker
 * processes, and whether nvidia-smi sees any GPUs. Mirrors the nodes-tab
 * Diagnose pattern.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const hostname = url.searchParams.get("host") ?? "";
  if (!hostname) {
    return NextResponse.json({ error: "Missing ?host=" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
  const node = hostsEntries.find((h) => h.hostname === hostname);
  if (!node) return NextResponse.json({ error: "Unknown host" }, { status: 404 });

  const target = await getClusterSshTarget(id);
  if (!target) return NextResponse.json({ error: "No SSH target" }, { status: 412 });
  const tgt = { ...target, bastion: cluster.sshBastion };

  const u = node.user || "root";
  const p = node.port || 22;

  // Single SSH-from-controller-ssh-into-node round-trip. All probes are
  // read-only; nothing on the node is changed.
  const inner = `
echo '== uname & uptime =='
uname -a; uptime

echo
echo '== :9100 (node exporter) =='
ss -ltnp 2>/dev/null | awk '$4 ~ /:9100$/' || true
HEAD9100=$(curl -sf --max-time 3 http://127.0.0.1:9100/metrics 2>/dev/null | head -10)
if [ -n "$HEAD9100" ]; then
  echo "[ok] :9100 responded — first metrics:"
  echo "$HEAD9100" | sed 's/^/  /'
else
  echo "[no] :9100 not responding"
fi
if systemctl list-unit-files 2>/dev/null | grep -q '^node_exporter\\.service'; then
  echo "[unit] node_exporter:"
  systemctl is-active node_exporter; systemctl is-enabled node_exporter
fi

echo
echo '== :9400 (gpu exporter) =='
ss -ltnp 2>/dev/null | awk '$4 ~ /:9400$/' || true
HEAD9400=$(curl -sf --max-time 3 http://127.0.0.1:9400/metrics 2>/dev/null | head -10)
if [ -n "$HEAD9400" ]; then
  echo "[ok] :9400 responded — first metrics:"
  echo "$HEAD9400" | sed 's/^/  /'
  if echo "$HEAD9400" | grep -q '^DCGM_FI_'; then echo "[type] DCGM exporter"; fi
  if echo "$HEAD9400" | grep -qE '^(nvidia_smi_|nvidia_gpu_)'; then echo "[type] nvidia_gpu_exporter"; fi
else
  echo "[no] :9400 not responding"
fi
if systemctl list-unit-files 2>/dev/null | grep -q '^nvidia_gpu_exporter\\.service'; then
  echo "[unit] nvidia_gpu_exporter:"
  systemctl is-active nvidia_gpu_exporter; systemctl is-enabled nvidia_gpu_exporter
fi
if command -v docker >/dev/null 2>&1; then
  CONT=$(docker ps -a --format '{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null | grep -E '9400|dcgm' || true)
  if [ -n "$CONT" ]; then
    echo "[docker] containers touching :9400 / dcgm:"
    echo "$CONT" | sed 's/^/  /'
  fi
fi

echo
echo '== nvidia-smi =='
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi -L 2>&1 | head -10
else
  echo "[none] nvidia-smi not found"
fi
`;

  const cmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p ${p} ${u}@${node.ip} bash -s <<'DIAG_EOF'
set +e
${inner}
DIAG_EOF`;

  const r = await sshExecSimple(tgt, cmd);
  return NextResponse.json({
    hostname: node.hostname,
    ip: node.ip,
    success: r.success,
    output: r.stdout,
    stderr: r.stderr,
  });
}
