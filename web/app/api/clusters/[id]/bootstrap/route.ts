import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface HostEntry {
  hostname: string;
  ip: string;
  port?: number;
}

function hostVars(entry: HostEntry, sshKeyFile?: string, extraVars?: Record<string, string>): string {
  const parts: Record<string, string> = {
    ansible_host: entry.ip,
    ansible_user: "root",
    ansible_python_interpreter: "/usr/bin/python3",
  };

  if (entry.port && entry.port !== 22) {
    parts.ansible_port = String(entry.port);
  }

  // Use cluster SSH key file, or fall back to ANSIBLE_SSH_KEY_FILE env var
  const keyFile = sshKeyFile ?? process.env.ANSIBLE_SSH_KEY_FILE;
  if (keyFile) {
    parts.ansible_ssh_private_key_file = keyFile;
  }

  Object.assign(parts, extraVars);

  return Object.entries(parts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

function buildInventory(config: Record<string, unknown>, sshKeyFile?: string): string {
  const controllerHost = config.slurm_controller_host as string;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as HostEntry[];

  const controllerEntry = hostsEntries.find((h) => h.hostname === controllerHost);
  const workerEntries = hostsEntries.filter((h) => h.hostname !== controllerHost);

  const controllerLine = controllerEntry
    ? `${controllerHost} ${hostVars(controllerEntry, sshKeyFile)}`
    : `${controllerHost} ansible_user=root ansible_python_interpreter=/usr/bin/python3${sshKeyFile ? ` ansible_ssh_private_key_file=${sshKeyFile}` : ""}`;

  const workerLines = workerEntries
    .map((h) => `${h.hostname} ${hostVars(h, sshKeyFile)}`)
    .join("\n");

  return `[slurm_controllers]\n${controllerLine}\n\n[slurm_workers]\n${workerLines}\n`;
}

// POST /api/clusters/[id]/bootstrap — run Ansible bootstrap and stream output as SSE
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) {
    return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  }

  const body = await req.json();
  let config = (body.config ?? cluster.config) as Record<string, unknown>;

  // Inject the cluster's database UUID so the agent's CLUSTER_ID matches
  // the NATS subjects the web server uses (aura.cluster.<UUID>.*).
  config = { ...config, aura_cluster_id: id };

  // Allow server-side env vars to override sensitive/environment-specific fields.
  if (process.env.AURA_AGENT_BINARY_SRC) {
    config = { ...config, aura_agent_binary_src: process.env.AURA_AGENT_BINARY_SRC };
  }

  const playbookDir = process.env.ANSIBLE_PLAYBOOKS_DIR ?? "/opt/aura/ansible";
  // ANSIBLE_PLAYBOOK overrides the default bootstrap.yml (e.g. test-bootstrap.yml for local E2E testing)
  const playbookFile = process.env.ANSIBLE_PLAYBOOK ?? "bootstrap.yml";

  const enc = new TextEncoder();
  let seq = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // client disconnected
        }
      };

      let tmpDir: string | null = null;

      try {
        // Write temp files
        tmpDir = mkdtempSync(join(tmpdir(), "aura-bootstrap-"));
        const inventoryPath = join(tmpDir, "inventory.ini");
        const configPath = join(tmpDir, "cluster-config.json");

        // Write cluster SSH key to temp file if available
        let sshKeyFile: string | undefined;
        if (cluster.sshKey) {
          sshKeyFile = join(tmpDir, "ssh_key");
          writeFileSync(sshKeyFile, cluster.sshKey.privateKey, { mode: 0o600 });
        }

        writeFileSync(inventoryPath, buildInventory(config, sshKeyFile));
        writeFileSync(configPath, JSON.stringify(config, null, 2));

        send({ type: "stream", line: `[aura] Starting bootstrap for cluster: ${cluster.name}`, seq: seq++ });
        send({ type: "stream", line: `[aura] Inventory: ${inventoryPath}`, seq: seq++ });
        send({ type: "stream", line: `[aura] Playbook dir: ${playbookDir}`, seq: seq++ });
        send({ type: "stream", line: "", seq: seq++ });

        const args = [
          "-i", inventoryPath,
          "-e", `@${configPath}`,
          "--diff",
          join(playbookDir, playbookFile),
        ];

        send({ type: "stream", line: `[aura] Running: ansible-playbook ${args.join(" ")}`, seq: seq++ });

        const proc = spawn("ansible-playbook", args, {
          env: {
            ...process.env,
            ANSIBLE_FORCE_COLOR: "0",
            ANSIBLE_NOCOLOR: "1",
            // Disable host key checking for all environments (controller validates hosts via inventory)
            ANSIBLE_HOST_KEY_CHECKING: "False",
          },
        });

        proc.stdout.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().split("\n")) {
            if (line) send({ type: "stream", line, seq: seq++ });
          }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().split("\n")) {
            if (line) send({ type: "stream", line: `[stderr] ${line}`, seq: seq++ });
          }
        });

        proc.on("close", async (code) => {
          try {
            if (code === 0) {
              await prisma.cluster.update({
                where: { id },
                data: { status: "ACTIVE" },
              });
              send({ type: "complete", success: true });
            } else {
              send({
                type: "complete",
                success: false,
                message: `ansible-playbook exited with code ${code}`,
              });
            }
          } finally {
            controller.close();
            if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
          }
        });

        proc.on("error", (err) => {
          send({
            type: "complete",
            success: false,
            message: `Failed to start ansible-playbook: ${err.message}. Is ansible installed and ANSIBLE_PLAYBOOKS_DIR set?`,
          });
          controller.close();
          if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
        });
      } catch (err) {
        send({
          type: "complete",
          success: false,
          message: err instanceof Error ? err.message : "Unknown error",
        });
        controller.close();
        if (tmpDir) {
          try {
            rmSync(tmpDir, { recursive: true, force: true });
          } catch {}
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
