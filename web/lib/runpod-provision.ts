// Background provisioning for RunPod-backed clusters (single node: the pod
// is both controller and worker). POST /api/clusters/runpod creates the pod
// + cluster row + a BackgroundTask of type "runpod_provision", then calls
// runRunpodProvision fire-and-forget. We poll RunPod until the SSH endpoint
// (public ip + mapped port 22) is assigned, write it onto the cluster row,
// then verify SSH actually accepts the injected key before marking the task
// done. Bootstrap stays a separate, explicit step on the Configuration tab —
// same as ssh-sourced clusters.

import { prisma } from "./prisma";
import { getRunPodPod, extractRunPodSshEndpoint } from "./gpu-provider";
import { sshExecSimple, buildSshTargetFromCluster } from "./ssh-exec";

const POLL_INTERVAL_MS = 5_000;
// RunPod cold pulls of the pytorch image can take a while.
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const SSH_VERIFY_ATTEMPTS = 12;
const SSH_VERIFY_INTERVAL_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function appendLog(taskId: string, line: string) {
  try {
    await prisma.$executeRaw`UPDATE "BackgroundTask" SET logs = logs || ${line + "\n"} WHERE id = ${taskId}`;
  } catch {}
}

async function finishTask(taskId: string, success: boolean) {
  await prisma.backgroundTask.update({
    where: { id: taskId },
    data: { status: success ? "success" : "failed", completedAt: new Date() },
  });
}

export async function runRunpodProvision(taskId: string, clusterId: string) {
  try {
    const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } });
    if (!cluster) { await finishTask(taskId, false); return; }

    const rp = (cluster.config as any)?.runpod;
    const provider = rp?.providerId
      ? await prisma.gpuProvider.findUnique({ where: { id: rp.providerId } })
      : null;
    if (!rp?.podId || !provider) {
      await appendLog(taskId, "[aura] Cluster has no RunPod pod reference — nothing to provision.");
      await finishTask(taskId, false);
      return;
    }

    const volumeDesc = rp.volumeGb > 0
      ? `${rp.volumeGb} GB volume at ${rp.volumeMountPath}`
      : "no persistent volume";
    await appendLog(taskId, `[aura] RunPod pod ${rp.podId} requested: ${rp.gpuTypeId} ×${rp.gpuCount}, ${rp.cloudType} cloud, ${rp.containerDiskGb} GB container disk, ${volumeDesc}`);
    await appendLog(taskId, `[aura] Image: ${rp.imageName}`);
    await appendLog(taskId, "[aura] Waiting for the pod to come online (cold image pulls can take several minutes)...");

    // Phase 1: poll until RunPod assigns the public SSH endpoint.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let lastStatus = "";
    let endpoint: { ip: string; port: number } | null = null;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      // Bail out quietly if the cluster was deleted mid-provision — the
      // delete route terminates the pod itself.
      const still = await prisma.cluster.findUnique({ where: { id: clusterId }, select: { id: true } });
      if (!still) {
        await appendLog(taskId, "[aura] Cluster was deleted — aborting provisioning.");
        await finishTask(taskId, false);
        return;
      }

      let pod: any;
      try {
        pod = await getRunPodPod(provider.apiKey, rp.podId);
      } catch (err: any) {
        await appendLog(taskId, `[aura] Poll failed (will retry): ${err?.message ?? err}`);
        continue;
      }

      const status = String(pod?.desiredStatus ?? pod?.status ?? "");
      if (status && status !== lastStatus) {
        lastStatus = status;
        await appendLog(taskId, `[aura] Pod status: ${status}`);
      }

      const { ip, port } = extractRunPodSshEndpoint(pod);
      if (ip && port) { endpoint = { ip, port }; break; }
    }

    if (!endpoint) {
      await appendLog(taskId, `[aura] SSH endpoint not assigned after ${POLL_TIMEOUT_MS / 60000} minutes — the pod may still be pulling the image. Check the RunPod dashboard; delete this cluster to terminate the pod.`);
      await finishTask(taskId, false);
      return;
    }

    // Persist connection coords. Keep status PROVISIONING — bootstrap is
    // what flips a cluster ACTIVE.
    const cfg = (cluster.config as any) ?? {};
    await prisma.cluster.update({
      where: { id: clusterId },
      data: {
        controllerHost: endpoint.ip,
        sshPort: endpoint.port,
        config: { ...cfg, slurm_controller_host: endpoint.ip },
      },
    });
    await appendLog(taskId, `[aura] SSH endpoint assigned: root@${endpoint.ip}:${endpoint.port}`);

    // Phase 2: the endpoint existing doesn't mean sshd is up or the injected
    // key has landed in authorized_keys yet — retry a real login.
    await appendLog(taskId, "[aura] Verifying SSH access with the cluster key...");
    const fresh = await prisma.cluster.findUnique({ where: { id: clusterId }, include: { sshKey: true } });
    if (!fresh?.sshKey) {
      await appendLog(taskId, "[aura] Cluster has no SSH key attached — cannot verify access.");
      await finishTask(taskId, false);
      return;
    }
    const target = buildSshTargetFromCluster(fresh);

    for (let attempt = 1; attempt <= SSH_VERIFY_ATTEMPTS; attempt++) {
      const res = await sshExecSimple(target, "hostname && echo __AURA_SSH_OK__");
      if (res.success && res.stdout.includes("__AURA_SSH_OK__")) {
        const hostname = res.stdout.split("\n").map((l) => l.trim()).find((l) => l && l !== "__AURA_SSH_OK__" && !l.startsWith("Warning:"));
        await appendLog(taskId, `[aura] SSH verified — connected to ${hostname ?? endpoint.ip}.`);

        const gpus = await sshExecSimple(target, "nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | sort | uniq -c");
        if (gpus.success && gpus.stdout.trim()) {
          await appendLog(taskId, `[aura] GPUs visible in pod:\n${gpus.stdout.trim()}`);
        }

        // Several flows (metrics install, user provisioning, package sync)
        // run on the controller and then `ssh root@<node>` to each node —
        // on a single-node pod that's the controller SSH-ing to itself,
        // which fails out of the box: the pod only has Aura's *public* key.
        // Generate a self-authorized root keypair so those nested hops work.
        const selfKey = await sshExecSimple(
          target,
          "mkdir -p /root/.ssh && chmod 700 /root/.ssh && " +
            "[ -f /root/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519 -q; " +
            "grep -qF \"$(cat /root/.ssh/id_ed25519.pub)\" /root/.ssh/authorized_keys 2>/dev/null || cat /root/.ssh/id_ed25519.pub >> /root/.ssh/authorized_keys",
        );
        await appendLog(
          taskId,
          selfKey.success
            ? "[aura] Pod root key self-authorised (needed for controller→node hops on a single-node pod)."
            : `[aura] Warning: could not self-authorise the pod's root key: ${selfKey.stderr.slice(0, 200)}`,
        );

        await appendLog(taskId, "[aura] Pod is ready. Run Bootstrap from the cluster's Configuration tab to install Slurm.");
        await finishTask(taskId, true);
        return;
      }
      if (attempt < SSH_VERIFY_ATTEMPTS) {
        await appendLog(taskId, `[aura] SSH not accepting the key yet (attempt ${attempt}/${SSH_VERIFY_ATTEMPTS}) — retrying in ${SSH_VERIFY_INTERVAL_MS / 1000}s...`);
        await sleep(SSH_VERIFY_INTERVAL_MS);
      }
    }

    await appendLog(taskId, "[aura] SSH endpoint is up but logins keep failing. Confirm the image honours the PUBLIC_KEY env var (runpod/pytorch images do), or test manually:");
    await appendLog(taskId, `[aura]   ssh -p ${endpoint.port} root@${endpoint.ip}`);
    await finishTask(taskId, false);
  } catch (err: any) {
    await appendLog(taskId, `[aura] Provisioning crashed: ${err?.message ?? err}`);
    await finishTask(taskId, false);
  }
}
