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

# Restart slurmctld
$S systemctl start slurmctld 2>&1 || true
echo "  slurmctld restarted"
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
