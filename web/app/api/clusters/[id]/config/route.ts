import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { unredactConfig } from "@/lib/redact-config";
import {
  containerExtraVars,
  isContainerCluster,
  propagateConfigPlaybook,
} from "@/lib/container-cluster";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface HostEntry { hostname: string; ip: string; user?: string; port?: number }

// Fire-and-forget container config propagation. Runs ansible-playbook
// propagate_config_container.yml in the background; output ends up in the
// process log (no SSE here since the config PATCH endpoint is request/
// response, not streaming).
function runContainerPropagate(cluster: any, config: Record<string, unknown>): void {
  const playbookDir = process.env.ANSIBLE_PLAYBOOKS_DIR ?? "/opt/aura/ansible";
  const playbookFile = propagateConfigPlaybook(cluster);
  const mergedConfig = { ...config, ...containerExtraVars(cluster) };

  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "aura-propagate-"));
    const inventoryPath = join(tmpDir, "inventory.ini");
    const configPath = join(tmpDir, "cluster-config.json");

    let sshKeyFile: string | undefined;
    if (cluster.sshKey) {
      sshKeyFile = join(tmpDir, "ssh_key");
      writeFileSync(sshKeyFile, cluster.sshKey.privateKey, { mode: 0o600 });
    }
    const keyArg = sshKeyFile ? ` ansible_ssh_private_key_file=${sshKeyFile}` : "";
    const proxyArg = cluster.sshProxyCommand && cluster.sshProxyCommand.trim()
      ? ` ansible_ssh_common_args='-o ProxyCommand="${String(cluster.sshProxyCommand).replace(/'/g, "'\\''")}"'`
      : "";

    const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];
    const controllerLine = `${cluster.controllerHost} ansible_host=${cluster.controllerHost} ansible_user=${cluster.sshUser} ansible_port=${cluster.sshPort} ansible_python_interpreter=/usr/bin/python3${keyArg}${proxyArg}`;
    const workerLines = hostsEntries
      .filter((h) => h.hostname !== cluster.controllerHost && h.ip !== cluster.controllerHost)
      .map((h: any) => `${h.hostname} ansible_host=${h.ip} ansible_user=${h.user || cluster.sshUser} ansible_port=${h.port || 22} ansible_python_interpreter=/usr/bin/python3${keyArg}${proxyArg}`)
      .join("\n");

    writeFileSync(
      inventoryPath,
      `[slurm_controllers]\n${controllerLine}\n\n[slurm_workers]\n${workerLines}\n\n[slurm:children]\nslurm_controllers\nslurm_workers\n`,
    );
    writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2));

    const proc = spawn(
      "ansible-playbook",
      [
        "-i", inventoryPath,
        "-e", `@${configPath}`,
        join(playbookDir, playbookFile),
      ],
      {
        env: {
          ...process.env,
          ANSIBLE_FORCE_COLOR: "0",
          ANSIBLE_NOCOLOR: "1",
          ANSIBLE_HOST_KEY_CHECKING: "False",
        },
        detached: true,
        stdio: "ignore",
      },
    );
    proc.unref();
    proc.on("close", () => {
      if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
    });
  } catch (err) {
    console.error("[propagate-container] failed to spawn:", err);
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  }
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/config — update and propagate config
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  const body = await req.json();
  const { config: incoming } = body;

  if (!incoming) {
    return NextResponse.json(
      { error: "Missing required field: config" },
      { status: 400 }
    );
  }

  // The editor ships masked secrets. Merge the real values back in from the
  // stored config so the user doesn't accidentally zero them out.
  const config = unredactConfig(incoming, cluster.config);

  const updatedCluster = await prisma.cluster.update({
    where: { id },
    data: { config: config as any },
  });

  // Container clusters always propagate via Ansible — the agent's NATS
  // propagate_config handler still calls the baremetal playbook with the
  // NFS-write step which doesn't exist on the container. Run our own
  // container playbook directly.
  if (isContainerCluster(updatedCluster)) {
    const freshCluster = await prisma.cluster.findUnique({
      where: { id },
      include: { sshKey: true },
    });
    if (freshCluster?.sshKey) {
      runContainerPropagate(freshCluster, config);
    }
    return NextResponse.json({
      cluster: updatedCluster,
      request_id: "container-propagate-detached",
    });
  }

  // Propagate to agent (non-blocking — long-running Ansible operation)
  const requestId = randomUUID();
  try {
    await publishCommand(id, {
      request_id: requestId,
      type: "propagate_config",
      payload: { config },
    });

    return NextResponse.json({
      cluster: updatedCluster,
      request_id: requestId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Config saved but propagation failed
    return NextResponse.json(
      {
        cluster: updatedCluster,
        warning: `Config saved but failed to queue propagation: ${message}`,
      },
      { status: 207 }
    );
  }
}
