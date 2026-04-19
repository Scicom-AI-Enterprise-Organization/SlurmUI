import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams {
  params: Promise<{ id: string; nodeName: string }>;
}

// DELETE /api/clusters/[id]/nodes/[nodeName] — remove a node from slurm.conf and DB
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id, nodeName } = await params;
  const session = await auth();

  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  const output: string[] = [];

  // 1. Remove from DB config
  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as Array<{ hostname: string }>;
  const filteredHosts = hostsEntries.filter((h) => h.hostname !== nodeName);
  const slurmNodes = (config.slurm_nodes ?? []) as Array<{ expression?: string }>;
  const filteredNodes = slurmNodes.filter((n) => n.expression !== nodeName);

  await prisma.cluster.update({
    where: { id },
    data: {
      config: {
        ...config,
        slurm_hosts_entries: filteredHosts,
        slurm_nodes: filteredNodes,
      } as any,
    },
  });
  output.push(`[1/3] Removed ${nodeName} from cluster config (${hostsEntries.length} → ${filteredHosts.length} entries)`);

  // 2. Remove from slurm.conf on controller + clear Slurm state
  output.push(`[2/3] Removing ${nodeName} from slurm.conf on controller...`);
  const script = `
set +e
S=""
if [ "$(id -u)" != "0" ]; then S="sudo"; fi

# Stop slurmctld and slurmd so we can clear state
$S systemctl stop slurmctld 2>&1 || true
$S systemctl stop slurmd 2>&1 || true

# Remove NodeName line
$S sed -i "/^NodeName=${nodeName} /d" /etc/slurm/slurm.conf

# Remove from partition Nodes= (handle: Nodes=X / Nodes=X,Y / Nodes=Y,X / Nodes=A,X,B)
$S sed -i "s|Nodes=${nodeName},|Nodes=|g" /etc/slurm/slurm.conf
$S sed -i "s|,${nodeName}||g" /etc/slurm/slurm.conf

# If a partition now has empty Nodes=, remove the whole line
$S sed -i "/^PartitionName=.*Nodes=[[:space:]]/d" /etc/slurm/slurm.conf
$S sed -i "/^PartitionName=.*Nodes=$/d" /etc/slurm/slurm.conf

# If this was the only node, remove gres.conf and Gres-related lines
REMAINING_NODES=$($S grep -c "^NodeName=" /etc/slurm/slurm.conf || echo 0)
if [ "$REMAINING_NODES" = "0" ]; then
  $S rm -f /etc/slurm/gres.conf 2>/dev/null || true
  echo "  No more nodes — removed gres.conf"
fi

echo "  slurm.conf updated"

# Clear cached slurmctld state
$S rm -rf /var/spool/slurmctld/node_state* /var/spool/slurmctld/last_config_lite /var/spool/slurmctld/cluster_state 2>/dev/null || true
echo "  cleared cached slurmctld state"

# Restart slurmctld AND slurmd — we stopped both above to clear cached
# state, so both need to come back. If we skip slurmd, the controller node
# (which also runs slurmd in single-VM / all-in-one setups) ends up stuck
# in UNKNOWN/NOT_RESPONDING after every delete.
$S systemctl start slurmctld 2>&1 || true
echo "  slurmctld restarted"
$S systemctl start slurmd 2>&1 || true
echo "  slurmd restarted"
`;

  // Run the script via sshExecScript (handles bastion mode properly via base64)
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed && !trimmed.match(/^[a-z]+@[^:]+:[~\/].*\$/) && !trimmed.startsWith("To run a command")) {
          output.push(trimmed);
        }
      },
      onComplete: () => resolve(),
    });
  });

  // 3. Done
  output.push(`[3/3] Done.`);

  await logAudit({
    action: "node.delete",
    entity: "Cluster",
    entityId: id,
    metadata: { nodeName },
  });

  return NextResponse.json({
    success: true,
    output: output.join("\n"),
  });
}

// PATCH /api/clusters/[id]/nodes/[nodeName] — edit IP / SSH user / SSH port
// for an existing node. Updates cluster.config and rewrites the NodeAddr line
// in slurm.conf on the controller, then restarts slurmctld so workers can be
// reached at the new address.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, nodeName } = await params;
  const session = await auth();
  if (!session?.user || (session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json()) as {
    ip?: string;
    sshUser?: string;
    sshPort?: number;
    cpus?: number;
    gpus?: number;
    memoryMb?: number;
    sockets?: number;
    coresPerSocket?: number;
    threadsPerCore?: number;
  };

  const ip = (body.ip ?? "").trim();
  const sshUser = (body.sshUser ?? "").trim();
  const sshPort = body.sshPort;
  const cpus = body.cpus;
  const gpus = body.gpus;
  const memoryMb = body.memoryMb;
  const sockets = body.sockets;
  const coresPerSocket = body.coresPerSocket;
  const threadsPerCore = body.threadsPerCore;

  const anyHwChanged = [cpus, gpus, memoryMb, sockets, coresPerSocket, threadsPerCore]
    .some((v) => v !== undefined);

  if (ip && !/^[0-9a-zA-Z._:-]+$/.test(ip)) {
    return NextResponse.json({ error: "Invalid IP / hostname" }, { status: 400 });
  }
  if (sshUser && !/^[a-z_][a-z0-9_-]*$/i.test(sshUser)) {
    return NextResponse.json({ error: "Invalid SSH user" }, { status: 400 });
  }
  if (sshPort !== undefined && (sshPort < 1 || sshPort > 65535)) {
    return NextResponse.json({ error: "SSH port must be 1-65535" }, { status: 400 });
  }
  for (const [name, v] of [["cpus", cpus], ["memoryMb", memoryMb], ["sockets", sockets], ["coresPerSocket", coresPerSocket], ["threadsPerCore", threadsPerCore]] as const) {
    if (v !== undefined && (!Number.isFinite(v) || v < 1)) {
      return NextResponse.json({ error: `${name} must be a positive integer` }, { status: 400 });
    }
  }
  if (gpus !== undefined && (!Number.isFinite(gpus) || gpus < 0)) {
    return NextResponse.json({ error: "gpus must be a non-negative integer" }, { status: 400 });
  }
  if (!ip && !sshUser && sshPort === undefined && !anyHwChanged) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  // Update cluster.config — both slurm_hosts_entries (hostname/ip) and
  // slurm_nodes (which optionally carries ssh_user / ssh_port per node).
  // If the node was registered via the bootstrap placeholder rather than the
  // Add-Node flow (so it lives only in slurm.conf, not our DB), create entries
  // here so the edit takes hold.
  const config = (cluster.config ?? {}) as Record<string, unknown>;
  const hosts = (config.slurm_hosts_entries ?? []) as Array<Record<string, unknown>>;
  const nodes = (config.slurm_nodes ?? []) as Array<Record<string, unknown>>;
  let touchedHosts = false;
  let touchedNodes = false;

  let hostEntry = hosts.find((h) => h.hostname === nodeName);
  if (!hostEntry) {
    hostEntry = { hostname: nodeName };
    hosts.push(hostEntry);
    touchedHosts = true;
  }
  if (ip) { hostEntry.ip = ip; touchedHosts = true; }
  if (sshUser) { hostEntry.user = sshUser; touchedHosts = true; }
  if (sshPort !== undefined) { hostEntry.port = sshPort; touchedHosts = true; }

  let nodeEntry = nodes.find((n) => n.expression === nodeName || n.name === nodeName);
  if (!nodeEntry) {
    // Edits don't know the hardware shape — seed with defaults so the slurm
    // controller template (which expects cpus / memory_mb) doesn't crash.
    // Add Node fills in real values when the user runs hardware detection.
    nodeEntry = { expression: nodeName, cpus: 1, gpus: 0, memory_mb: 1024 };
    nodes.push(nodeEntry);
    touchedNodes = true;
  }
  if (ip) { nodeEntry.ip = ip; touchedNodes = true; }
  if (sshUser) { nodeEntry.ssh_user = sshUser; touchedNodes = true; }
  if (sshPort !== undefined) { nodeEntry.ssh_port = sshPort; touchedNodes = true; }
  if (cpus !== undefined) { nodeEntry.cpus = cpus; touchedNodes = true; }
  if (gpus !== undefined) { nodeEntry.gpus = gpus; touchedNodes = true; }
  if (memoryMb !== undefined) { nodeEntry.memory_mb = memoryMb; touchedNodes = true; }
  if (sockets !== undefined) { nodeEntry.sockets = sockets; touchedNodes = true; }
  if (coresPerSocket !== undefined) { nodeEntry.cores_per_socket = coresPerSocket; touchedNodes = true; }
  if (threadsPerCore !== undefined) { nodeEntry.threads_per_core = threadsPerCore; touchedNodes = true; }

  if (!touchedHosts && !touchedNodes) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await prisma.cluster.update({
    where: { id },
    data: {
      config: {
        ...config,
        slurm_hosts_entries: hosts,
        slurm_nodes: nodes,
      } as never,
    },
  });

  // Rewrite the NodeName= line on the controller's slurm.conf whenever any
  // IP / hardware field changed (sshUser/sshPort are DB-only — Slurm doesn't
  // read them). We replace the whole line by name rather than patch individual
  // fields so the new config is always complete and consistent.
  const output: string[] = [];
  const changes: string[] = [];
  if (ip) changes.push(`ip=${ip}`);
  if (sshUser) changes.push(`sshUser=${sshUser}`);
  if (sshPort !== undefined) changes.push(`sshPort=${sshPort}`);
  if (cpus !== undefined) changes.push(`cpus=${cpus}`);
  if (gpus !== undefined) changes.push(`gpus=${gpus}`);
  if (memoryMb !== undefined) changes.push(`memoryMb=${memoryMb}`);
  if (sockets !== undefined) changes.push(`sockets=${sockets}`);
  if (coresPerSocket !== undefined) changes.push(`coresPerSocket=${coresPerSocket}`);
  if (threadsPerCore !== undefined) changes.push(`threadsPerCore=${threadsPerCore}`);
  output.push(`[1/2] Updated cluster config for ${nodeName}${changes.length ? ` (${changes.join(", ")})` : ""}`);

  const needsSlurmConfRewrite = ip || anyHwChanged;
  if (needsSlurmConfRewrite && cluster.sshKey && cluster.connectionMode === "SSH") {
    output.push(`[2/2] Rewriting slurm.conf NodeName=${nodeName} line on controller…`);
    // Build the canonical NodeName= line from the merged node entry so every
    // field (old + newly-edited) lands in slurm.conf.
    const effIp = String(nodeEntry.ip ?? "") || ip;
    const effCpus = Number(nodeEntry.cpus ?? 1);
    const effGpus = Number(nodeEntry.gpus ?? 0);
    const effMem = Number(nodeEntry.memory_mb ?? 1024);
    const effSockets = Number(nodeEntry.sockets ?? 1);
    const effCores = Number(nodeEntry.cores_per_socket ?? effCpus);
    const effThreads = Number(nodeEntry.threads_per_core ?? 1);
    const gresPart = effGpus > 0 ? `Gres=gpu:${effGpus} ` : "";
    const nodeLine =
      `NodeName=${nodeName}` +
      (effIp ? ` NodeAddr=${effIp}` : "") +
      ` CPUs=${effCpus} Sockets=${effSockets} CoresPerSocket=${effCores} ThreadsPerCore=${effThreads}` +
      ` RealMemory=${effMem} ${gresPart}State=UNKNOWN`;

    const target = {
      host: cluster.controllerHost,
      user: cluster.sshUser,
      port: cluster.sshPort,
      privateKey: cluster.sshKey.privateKey,
      bastion: cluster.sshBastion,
    };
    const script = `#!/bin/bash
set +e
S=""; if [ "$(id -u)" != "0" ]; then S="sudo"; fi
# Remove any existing NodeName line for this node, then append the rebuilt
# one. Ensures we don't end up with duplicates or a partial merge.
$S sed -i "/^NodeName=${nodeName} /d" /etc/slurm/slurm.conf
echo "${nodeLine}" | $S tee -a /etc/slurm/slurm.conf > /dev/null
echo "  rewrote NodeName line:"
echo "    ${nodeLine}"

# Bounce slurmctld + slurmd so the new config is picked up. slurmd on this
# box may be the controller's (all-in-one single-VM); restart is cheap.
$S systemctl restart slurmctld 2>&1 | head -3
$S systemctl restart slurmd 2>&1 | head -3 || true
echo "  slurmctld + slurmd restarted"

# If the IP changed, try to nudge the node out of DOWN/DRAIN so it picks
# up the new NodeAddr. Silent on "Invalid node state specified" — that's
# the friendly rejection when the node is already idle/unknown.
${ip ? `$S scontrol update NodeName=${nodeName} State=RESUME 2>&1 | grep -v "Invalid node state" || true` : ""}
`;
    await new Promise<void>((resolve) => {
      sshExecScript(target, script, {
        onStream: (line) => {
          const t = line.replace(/\r/g, "").trim();
          if (t && !t.startsWith("[stderr]")) output.push(t);
        },
        onComplete: () => resolve(),
      });
    });
  } else {
    output.push(`[2/2] Skipping slurm.conf rewrite (nothing Slurm cares about changed, or non-SSH cluster).`);
  }

  await logAudit({
    action: "node.edit",
    entity: "Cluster",
    entityId: id,
    metadata: { nodeName, ip, sshUser, sshPort },
  });

  return NextResponse.json({
    success: true,
    output: output.join("\n"),
  });
}
