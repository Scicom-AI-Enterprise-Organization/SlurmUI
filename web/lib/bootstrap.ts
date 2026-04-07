import { spawn } from "child_process";
import { prisma } from "@/lib/prisma";
import { getNatsConnection, jsonCodec } from "@/lib/nats";
import { randomUUID } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export interface BootstrapOptions {
  clusterId: string;
  config: Record<string, unknown>;
  requestId: string;
}

/**
 * Run the bootstrap playbook for a new cluster.
 * Streams stdout lines via NATS to the stream subject.
 * Publishes final result to the reply subject.
 */
export async function runBootstrap(options: BootstrapOptions): Promise<void> {
  const { clusterId, config, requestId } = options;
  const nc = await getNatsConnection();

  const streamSubject = `aura.cluster.${clusterId}.stream.${requestId}`;
  const replySubject = `aura.cluster.${clusterId}.reply.${requestId}`;
  const playbooksDir = process.env.ANSIBLE_PLAYBOOKS_DIR ?? "/opt/aura/ansible";

  // Write cluster config to temp file
  const tmpDir = join(tmpdir(), "aura-bootstrap", clusterId);
  await mkdir(tmpDir, { recursive: true });
  const configPath = join(tmpDir, "cluster-config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  // Build inventory from config
  const inventoryPath = join(tmpDir, "inventory.ini");
  const inventory = buildInventory(config);
  await writeFile(inventoryPath, inventory);

  const playbookPath = join(playbooksDir, "bootstrap.yml");

  const args = [
    "-i", inventoryPath,
    `-e`, `@${configPath}`,
    playbookPath,
    "--diff",
  ];

  console.log(`[Bootstrap] Starting: ansible-playbook ${args.join(" ")}`);

  const child = spawn("ansible-playbook", args, {
    cwd: playbooksDir,
    env: {
      ...process.env,
      ANSIBLE_FORCE_COLOR: "0",
      ANSIBLE_NOCOLOR: "1",
    },
  });

  // Stream stdout
  child.stdout.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) {
        nc.publish(streamSubject, jsonCodec.encode(line));
      }
    }
  });

  // Stream stderr
  child.stderr.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) {
        nc.publish(streamSubject, jsonCodec.encode(`[stderr] ${line}`));
      }
    }
  });

  // Handle completion
  child.on("close", async (code) => {
    const success = code === 0;

    // Update cluster status
    await prisma.cluster.update({
      where: { id: clusterId },
      data: {
        status: success ? "ACTIVE" : "OFFLINE",
      },
    });

    // Publish result
    nc.publish(
      replySubject,
      jsonCodec.encode({
        success,
        exitCode: code,
        message: success
          ? "Bootstrap completed successfully"
          : `Bootstrap failed with exit code ${code}`,
      })
    );

    console.log(`[Bootstrap] Completed with exit code ${code}`);
  });

  child.on("error", async (err) => {
    console.error("[Bootstrap] Process error:", err);
    nc.publish(
      replySubject,
      jsonCodec.encode({
        success: false,
        exitCode: -1,
        message: `Bootstrap process error: ${err.message}`,
      })
    );

    await prisma.cluster.update({
      where: { id: clusterId },
      data: { status: "OFFLINE" },
    });
  });
}

/**
 * Build Ansible inventory from cluster config.
 */
function buildInventory(config: Record<string, unknown>): string {
  const controllerHost = config.slurm_controller_host as string;
  const hostsEntries = config.slurm_hosts_entries as Array<{ hostname: string; ip: string }>;

  const controller = hostsEntries.find((h) => h.hostname === controllerHost);
  const workers = hostsEntries.filter((h) => h.hostname !== controllerHost);

  let inv = "[slurm_controllers]\n";
  if (controller) {
    inv += `${controller.hostname} ansible_host=${controller.ip}\n`;
  }

  inv += "\n[slurm_workers]\n";
  for (const worker of workers) {
    inv += `${worker.hostname} ansible_host=${worker.ip}\n`;
  }

  inv += "\n[all:vars]\n";
  inv += "ansible_user=root\n";
  inv += "ansible_python_interpreter=/usr/bin/python3\n";

  return inv;
}
