/**
 * End-to-end regression for a RUNPOD-provisioned cluster (rented GPU pod).
 *
 * Unlike container-cluster.test.ts (which spins a local Docker container),
 * this suite rents a REAL pod from a RunPod account connected under
 * Admin → GPU Providers — it costs money while it runs (RTX A6000 ≈
 * $0.33–0.79/hr) and the afterAll cleanup deletes the cluster, which
 * terminates the pod. If the suite is killed hard (SIGKILL), check the
 * RunPod dashboard for a leftover pod named aura-<clusterName>.
 *
 * What this exercises end-to-end:
 *   - POST /api/clusters/runpod (rent pod → cluster row → provision task)
 *   - provisioning: SSH endpoint discovery + key verification + the
 *     self-authorised root key (controller→node nested hops on 1 node)
 *   - bootstrap on the pod (no systemd → pm2-go branch)
 *   - node-edit gres regression: Gres=gpu:N must survive a save — needs
 *     GresTypes=gpu + a gres.conf File= that globs the REAL device node
 *     (pods get the host minor, e.g. /dev/nvidia8, not /dev/nvidia0)
 *   - per-node venv with torch cu128 (the managed-GPU workflow)
 *   - a Slurm job with --gres=gpu:1 actually allocating the GPU
 *   - metrics exporters + Prom/Grafana under pm2, with the loopback
 *     scrape-target fix (pod public IP doesn't route to :9100 inside)
 *   - cluster delete terminating the pod
 *
 * Run via:
 *   ./scripts/regression-test-runpod.sh
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";

interface RegressEnv {
  base: string;
  token: string;
  clusterName: string;
  /** RunPod GPU type id, e.g. "NVIDIA RTX A6000". */
  gpuTypeId: string;
  /** Optional: pick a specific provider / SSH key by name. */
  gpuProviderName?: string;
  sshKeyName?: string;
}

const envPath = process.env.AURA_REGRESSION_ENV;
if (!envPath) throw new Error("AURA_REGRESSION_ENV env var is required (path to the JSON written by regression-test-runpod.sh)");
const env: RegressEnv = JSON.parse(readFileSync(envPath, "utf8"));

// ──────────────────────────────────────────────────────────────────────
// HTTP helpers (same shape as the container suite).
// ──────────────────────────────────────────────────────────────────────
type Json = Record<string, unknown>;
async function api<T = Json>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${env.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: T;
  try { data = text ? JSON.parse(text) as T : {} as T; }
  catch { data = { _raw: text } as unknown as T; }
  return { status: res.status, data };
}

/** Poll a BackgroundTask (by id) until terminal; returns {status, logs}. */
async function pollTask(taskId: string, timeoutMs: number): Promise<{ status: string; logs: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: any = {};
  while (Date.now() < deadline) {
    const r = await api<{ status: string; logs: string }>("GET", `/api/tasks/${taskId}`);
    last = r.data ?? {};
    if (last.status && last.status !== "running") return { status: last.status, logs: last.logs ?? "" };
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { status: `timeout (last=${last.status ?? "?"})`, logs: last.logs ?? "" };
}

/** Run a shell command on the controller via the v1 exec endpoint. */
async function exec(command: string): Promise<string> {
  const r = await api<{ stdout?: string; stderr?: string }>(
    "POST",
    `/api/v1/clusters/${state.clusterId}/exec`,
    { command },
  );
  expect(r.status, `exec failed: ${JSON.stringify(r.data).slice(0, 400)}`).toBe(200);
  return r.data.stdout ?? "";
}

const state: {
  providerId?: string;
  sshKeyId?: string;
  cloudType?: "COMMUNITY" | "SECURE";
  clusterId?: string;
  deleted?: boolean;
  masterHostname?: string;
  selfUserId?: string;
} = {};

const VENV_PATH = "/opt/aura-venv";
const TORCH_INDEX = "https://download.pytorch.org/whl/cu128";

describe("runpod cluster regression (rented GPU pod)", () => {
  beforeAll(() => {
    console.log(`[regress] cluster name: ${env.clusterName}`);
    console.log(`[regress] GPU type:     ${env.gpuTypeId}`);
  });

  // CRITICAL: the pod bills until terminated. Cluster delete terminates
  // the pod, so this must run even when the suite fails midway.
  afterAll(async () => {
    if (!state.clusterId || state.deleted) return;
    console.log(`[regress] afterAll cleanup → delete cluster ${state.clusterId} (terminates the RunPod pod)`);
    try {
      const r = await api("DELETE", `/api/clusters/${state.clusterId}`);
      console.log(`[regress] cleanup delete → http=${r.status}`);
    } catch (e) {
      console.error(`[regress] CLEANUP FAILED — terminate the pod manually on runpod.io! ${e}`);
    }
  }, 5 * 60 * 1000);

  // ─── 1. A RunPod provider account must be connected ──────────────────
  it("finds a connected RunPod provider", async () => {
    const r = await api<Array<{ id: string; name: string; kind: string }>>("GET", "/api/admin/gpu-providers");
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const providers = (r.data ?? []).filter((p) => p.kind === "runpod");
    const pick = env.gpuProviderName
      ? providers.find((p) => p.name === env.gpuProviderName)
      : providers[0];
    if (!pick) {
      throw new Error(
        `No RunPod provider${env.gpuProviderName ? ` named "${env.gpuProviderName}"` : ""} configured — add one under Admin → GPU Providers first.`,
      );
    }
    state.providerId = pick.id;
    console.log(`[regress] provider: ${pick.name} (${pick.id})`);
  });

  // ─── 2. The requested GPU type must be in stock somewhere ────────────
  // RunPod stock flaps minute-to-minute for popular types — poll the live
  // catalogue for a while before giving up, like a human retrying the UI.
  it(`finds ${env.gpuTypeId} in the live catalogue with stock`, async () => {
    type GpuRow = { id: string; stockStatus: string | null; communityCloud: boolean; secureCloud: boolean; pricePerHr: number | null };
    const deadline = Date.now() + 10 * 60 * 1000;
    let gpu: GpuRow | undefined;
    for (;;) {
      const r = await api<GpuRow[]>("GET", `/api/admin/gpu-providers/${state.providerId}/gpus`);
      expect(r.status, JSON.stringify(r.data).slice(0, 300)).toBe(200);
      gpu = (r.data ?? []).find((g) => g.id === env.gpuTypeId);
      expect(gpu, `GPU type "${env.gpuTypeId}" not offered by RunPod — ids look like "NVIDIA RTX A6000"`).toBeTruthy();
      if (gpu!.stockStatus) break;
      if (Date.now() > deadline) break;
      console.log(`[regress] ${env.gpuTypeId} out of stock — retrying in 30s`);
      await new Promise((res) => setTimeout(res, 30_000));
    }
    expect(gpu!.stockStatus, `${env.gpuTypeId} stayed out of stock for 10 minutes — rerun later or pick another type`).toBeTruthy();
    // Prefer SECURE: clusters need inbound SSH, and secure hosts reliably
    // support public TCP port mapping — community hosts are a lottery even
    // with supportPublicIp requested. The create step still falls back to
    // the other tier on "no instances".
    state.cloudType = gpu!.secureCloud ? "SECURE" : "COMMUNITY";
    console.log(`[regress] stock=${gpu!.stockStatus} $${gpu!.pricePerHr}/hr → trying ${state.cloudType} first`);
  }, 11 * 60 * 1000);

  // ─── 3. Resolve the SSH key whose public half goes into the pod ──────
  it("resolves the SSH key for pod injection", async () => {
    const r = await api<Array<{ id: string; name: string }>>("GET", "/api/admin/ssh-keys");
    expect(r.status).toBe(200);
    const want = env.sshKeyName ?? "runpod";
    const pick = (r.data ?? []).find((k) => k.name === want) ?? (r.data ?? [])[0];
    if (!pick) throw new Error("No SSH keys configured — add one under Admin → Settings → SSH Keys.");
    state.sshKeyId = pick.id;
    console.log(`[regress] ssh key: ${pick.name} (${pick.id})`);
  });

  // ─── 4. Rent the pod + create the cluster ────────────────────────────
  // Availability said "in stock" but RunPod can still refuse at create
  // time ("no instances currently available") — fall back to the other
  // cloud tier before giving up, same as a human retrying in the UI.
  it("creates the RunPod-backed cluster (rents the pod)", async () => {
    const body = {
      name: env.clusterName,
      gpuProviderId: state.providerId,
      gpuTypeId: env.gpuTypeId,
      gpuCount: 1,
      containerDiskGb: 50,
      volumeGb: 50,
      volumeMountPath: "/workspace",
      sshKeyId: state.sshKeyId,
    };
    let r = await api<{ id: string; taskId: string; error?: string }>(
      "POST", "/api/clusters/runpod", { ...body, cloudType: state.cloudType },
    );
    if (r.status === 502 && /no instances/i.test(String(r.data.error ?? ""))) {
      const other = state.cloudType === "COMMUNITY" ? "SECURE" : "COMMUNITY";
      console.log(`[regress] ${state.cloudType} had no instances → retrying ${other}`);
      state.cloudType = other;
      r = await api("POST", "/api/clusters/runpod", { ...body, cloudType: other });
    }
    expect(r.status, JSON.stringify(r.data).slice(0, 400)).toBe(201);
    state.clusterId = r.data.id;
    console.log(`[regress] cluster=${state.clusterId} provisionTask=${r.data.taskId}`);

    // Provisioning: poll RunPod until the SSH endpoint lands, then verify
    // a real login. Cold image pulls can take several minutes.
    const t = await pollTask(r.data.taskId, 15 * 60 * 1000);
    if (t.status !== "success") {
      throw new Error(`provisioning ${t.status}\n--- logs ---\n${t.logs.slice(-3000)}`);
    }
    expect(t.logs).toMatch(/SSH verified/);
    // Canary for the controller→node nested-hop fix: without the
    // self-authorised root key, metrics install / user provisioning all
    // fail with "Permission denied" later.
    expect(t.logs, "expected the pod root key to be self-authorised during provisioning").toMatch(/self-authorised/);
  }, 20 * 60 * 1000);

  // ─── 5. The cluster row got the pod's SSH coordinates ────────────────
  it("cluster row has the pod's public SSH endpoint", async () => {
    const r = await api<{ controllerHost: string; sshPort: number; config: any }>("GET", `/api/clusters/${state.clusterId}`);
    expect(r.status).toBe(200);
    expect(r.data.controllerHost, "controllerHost still empty after provisioning").toBeTruthy();
    expect(r.data.config?.runpod?.podId, "config.runpod.podId missing").toBeTruthy();
    console.log(`[regress] pod ssh: root@${r.data.controllerHost}:${r.data.sshPort} (pod ${r.data.config.runpod.podId})`);
  });

  // ─── 6. Bootstrap (pm2-go path — pods have no systemd) ───────────────
  // Uses the inner taskId+poll endpoint rather than the inline-waiting
  // /api/v1 wrapper: undici's fetch kills any request whose response
  // headers take >5 min (UND_ERR_HEADERS_TIMEOUT), and a cold-pod
  // bootstrap comfortably exceeds that.
  it("bootstraps the pod into a single-node Slurm cluster", async () => {
    const r = await api<{ taskId: string }>("POST", `/api/clusters/${state.clusterId}/bootstrap`, {});
    expect(r.status, JSON.stringify(r.data).slice(0, 300)).toBe(200);
    const t = await pollTask(r.data.taskId, 24 * 60 * 1000);
    if (t.status !== "success") {
      throw new Error(`bootstrap ${t.status}\n--- logs (tail) ---\n${t.logs.slice(-3000)}`);
    }
  }, 25 * 60 * 1000);

  // ─── 7. Partition + controller-as-node seeding (with the GPU) ───────
  it("auto-seeds 'main' partition and registers the pod as a GPU node", async () => {
    const r = await api<{ config: any }>("GET", `/api/clusters/${state.clusterId}`);
    expect(r.status).toBe(200);
    const cfg = r.data.config ?? {};
    const parts = (cfg.slurm_partitions ?? []) as Array<{ name: string }>;
    expect(parts.find((p) => p.name === "main"), `partitions=${JSON.stringify(parts)}`).toBeTruthy();

    const hosts = (cfg.slurm_hosts_entries ?? []) as Array<{ hostname: string }>;
    expect(hosts.length).toBeGreaterThan(0);
    state.masterHostname = hosts[0].hostname;

    const nodes = (cfg.slurm_nodes ?? []) as Array<{ expression: string; gpus?: number }>;
    const master = nodes.find((n) => n.expression === state.masterHostname);
    expect(master?.gpus ?? 0, `controller node should have detected the GPU; slurm_nodes=${JSON.stringify(nodes)}`).toBeGreaterThan(0);
  });

  // ─── 8. Gres regression: node edit must leave Slurm seeing the GPU ──
  // Three failure modes this guards (all hit in the field on RunPod):
  //   a) Gres=gpu:N written to slurm.conf without GresTypes / gres.conf
  //      → scontrol reports Gres=(null), UI shows 0
  //   b) gres.conf File=/dev/nvidia[0-(N-1)] but the pod's device node
  //      carries the HOST minor (e.g. /dev/nvidia8) → slurmd crash-loop
  //   c) file-less Count-only gres → Slurm 23.x ignores it → INVALID_REG
  it("node edit (gpus=1) keeps Slurm gres registered and the node schedulable", async () => {
    const r = await api<{ output?: string; error?: string }>(
      "PATCH",
      `/api/clusters/${state.clusterId}/nodes/${state.masterHostname}`,
      { gpus: 1 },
    );
    expect(r.status, JSON.stringify(r.data).slice(0, 400)).toBe(200);
    expect(r.data.output ?? "").toMatch(/ensured GresTypes=gpu/);

    // slurmd restarts + re-registers; poll until the node is POSITIVELY
    // schedulable (IDLE/MIXED/ALLOCATED) with the gres visible. "No bad
    // words" isn't enough: right after a slurmctld restart scontrol can
    // serve the pre-restart saved state, and a bad slurmd registration
    // (gres count 0 < 1 → INVALID_REG) only lands a few seconds later.
    const healthy = (s: string) => /Gres=gpu:1/.test(s)
      && /State=(IDLE|MIXED|ALLOCATED)(\+CLOUD)?\s/.test(s)
      && !/INVAL|NOT_RESPONDING|DOWN|UNKNOWN/.test(s);
    const probeNode = () => exec(
      `scontrol show node ${state.masterHostname} | grep -E 'Gres=|State='; echo ---; cat /etc/slurm/gres.conf 2>/dev/null`,
    );
    const deadline = Date.now() + 3 * 60 * 1000;
    let snapshot = "";
    while (Date.now() < deadline) {
      snapshot = await probeNode();
      if (healthy(snapshot)) {
        // Confirm it STAYS healthy across the registration window —
        // catches the late INVALID_REG race.
        await new Promise((res) => setTimeout(res, 15_000));
        snapshot = await probeNode();
        if (healthy(snapshot)) break;
      }
      await new Promise((res) => setTimeout(res, 10_000));
    }
    expect(healthy(snapshot), `node never became schedulable with gres; final:\n${snapshot}`).toBe(true);

    // gres.conf must reference a device node that actually exists (the
    // host-minor glob), or be Count-only when the pod exposes none.
    const fileMatch = snapshot.match(/File=([^\s,]+)/);
    if (fileMatch) {
      const probe = await exec(`[ -e ${fileMatch[1]} ] && echo DEV_OK || echo DEV_MISSING`);
      expect(probe, `gres.conf points at a missing device: ${fileMatch[1]}`).toMatch(/DEV_OK/);
    }
  }, 6 * 60 * 1000);

  // ─── 9. Provision the Bearer-token owner as a Linux user ────────────
  it("provisions the Bearer-token owner as a Linux user", async () => {
    const me = await api<{ user: { id: string } }>("GET", "/api/me");
    expect(me.status, JSON.stringify(me.data)).toBe(200);
    state.selfUserId = me.data.user.id;

    const r = await api("POST", `/api/v1/clusters/${state.clusterId}/users`, { userId: state.selfUserId });
    if (r.status !== 200 && r.status !== 201 && r.status !== 409) {
      throw new Error(`user provision failed: http=${r.status} body=${JSON.stringify(r.data)}`);
    }
  }, 5 * 60 * 1000);

  // ─── 10. Per-node venv with torch cu128 ──────────────────────────────
  // ~3 GB of wheels from download.pytorch.org — the long pole of the suite.
  it("installs torch/torchvision/torchaudio (cu128) into the per-node venv", async () => {
    // Two-step inner flow (persist config, then apply → taskId) instead of
    // the inline-waiting v1 wrapper — see the bootstrap step for why.
    const put = await api("PUT", `/api/clusters/${state.clusterId}/python-packages`, {
      packages: [
        { name: "torch==2.10.0", indexUrl: TORCH_INDEX },
        { name: "torchvision==0.25.0", indexUrl: TORCH_INDEX },
        { name: "torchaudio==2.10.0", indexUrl: TORCH_INDEX },
      ],
      installMode: "per-node",
      localVenvPath: VENV_PATH,
      pythonVersion: "3.12",
    });
    expect(put.status, JSON.stringify(put.data).slice(0, 300)).toBe(200);

    const r = await api<{ taskId: string }>("POST", `/api/clusters/${state.clusterId}/python-packages/apply`, {});
    expect(r.status, JSON.stringify(r.data).slice(0, 300)).toBe(200);
    const t = await pollTask(r.data.taskId, 28 * 60 * 1000);
    if (t.status !== "success") {
      throw new Error(`torch venv install ${t.status}\n--- logs (tail) ---\n${t.logs.slice(-3000)}`);
    }
    expect(t.logs).toMatch(/torch\s+2\.10\.0\+cu128/);
  }, 30 * 60 * 1000);

  // ─── 11. CUDA job through Slurm with a real gres allocation ─────────
  it("runs a torch CUDA job with --gres=gpu:1 to completion", async () => {
    const script = [
      "#!/bin/bash",
      "#SBATCH --job-name=runpod-regress-cuda",
      "#SBATCH --partition=main",
      "#SBATCH --gres=gpu:1",
      "#SBATCH --time=00:10:00",
      "",
      'echo "CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES"',
      `source ${VENV_PATH}/bin/activate`,
      "python3 - <<'PY'",
      "import torch",
      "print('torch', torch.__version__)",
      "print('cuda available:', torch.cuda.is_available())",
      "print('device:', torch.cuda.get_device_name(0))",
      "x = torch.rand(4096, 4096, device='cuda')",
      "print('matmul ok:', float((x @ x).sum()) > 0)",
      "PY",
    ].join("\n");

    const sub = await api<{ id: string }>("POST", `/api/v1/clusters/${state.clusterId}/jobs`, { script });
    expect([200, 201], `unexpected status: ${sub.status} body=${JSON.stringify(sub.data)}`).toContain(sub.status);
    const jobId = sub.data.id;

    const deadline = Date.now() + 8 * 60 * 1000;
    let last: any = {};
    let output = "";
    while (Date.now() < deadline) {
      const r = await api<{ job: any; output: string | null }>("GET", `/api/v1/jobs/${jobId}?output=1`);
      last = r.data?.job ?? {};
      output = r.data?.output ?? "";
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(last.status)) break;
      await new Promise((res) => setTimeout(res, 5000));
    }
    // Output is resolved over SSH from scontrol/sacct — right at
    // completion that lookup can race the accounting flush and come back
    // empty (or as the watcher's "[aura] Could not resolve output file"
    // placeholder) even though the job finished fine. Retry briefly.
    const outUseless = (s: string) => !s || /Could not resolve output file/.test(s);
    const outDeadline = Date.now() + 90 * 1000;
    while (last.status === "COMPLETED" && outUseless(output) && Date.now() < outDeadline) {
      await new Promise((res) => setTimeout(res, 10_000));
      const r = await api<{ output: string | null }>("GET", `/api/v1/jobs/${jobId}?output=1`);
      output = r.data?.output ?? "";
    }

    if (last.status !== "COMPLETED") {
      // Pull the Slurm-side picture into the failure message — a PENDING
      // job's reason (Resources / ReqNodeNotAvail / drained node) is
      // invisible from the Aura job row alone.
      const slurmView = await exec(
        `squeue -o "%i %T %r %R" ; echo --- ; sinfo -R ; echo --- ; scontrol show node ${state.masterHostname} | grep -E "State=|Gres=|Reason"`,
      ).catch(() => "(slurm diagnostics unavailable)");
      throw new Error(
        `job did not complete: status=${last.status}\n--- slurm view ---\n${slurmView}\n--- job row ---\n${JSON.stringify(last)}\n--- output ---\n${output.slice(-2000)}`,
      );
    }
    expect(output).toMatch(/torch 2\.10\.0\+cu128/);
    expect(output).toMatch(/cuda available: True/);
    // Slurm only sets CUDA_VISIBLE_DEVICES when the gres allocation
    // actually happened — device visibility alone proves nothing in a
    // container where every process can see the GPU.
    expect(output, "gres allocation did not set CUDA_VISIBLE_DEVICES").toMatch(/CUDA_VISIBLE_DEVICES=\d/);
  }, 10 * 60 * 1000);

  // ─── 12. Metrics exporters (pm2, nvidia_smi mode — no docker in pods) ─
  it("installs node_exporter + GPU exporter under pm2", async () => {
    const start = await api<{ taskId: string }>("POST", `/api/clusters/${state.clusterId}/metrics/install`, {});
    expect(start.status, JSON.stringify(start.data).slice(0, 300)).toBe(200);
    const t = await pollTask(start.data.taskId, 14 * 60 * 1000);
    if (t.status !== "success") {
      throw new Error(`metrics/install ${t.status}\n--- logs (tail) ---\n${t.logs.slice(-3000)}`);
    }
    const logs = t.logs;
    expect(logs, `expected pm2 supervisor banner; tail:\n${logs.slice(-1200)}`).toMatch(/\[supervisor\][^\n]*pm2/);
    // Pods can't run docker → the auto mode must fall back to nvidia_smi.
    expect(logs, "expected nvidia_smi exporter mode inside a pod").toMatch(/nvidia_smi/);
    // The nested controller→node ssh must NOT be rejected (self-key fix).
    expect(logs, `metrics install hit Permission denied — self-authorised key broken?\n${logs.slice(-1200)}`).not.toMatch(/Permission denied/);
  }, 15 * 60 * 1000);

  // ─── 13. Prom + Grafana stack with loopback scrape targets ───────────
  it("deploys the Prometheus + Grafana stack and scrapes via loopback", async () => {
    const start = await api<{ taskId: string }>("POST", `/api/clusters/${state.clusterId}/metrics/grafana/deploy`, {});
    expect(start.status, JSON.stringify(start.data).slice(0, 300)).toBe(200);
    const t = await pollTask(start.data.taskId, 20 * 60 * 1000);
    if (t.status !== "success") {
      throw new Error(`metrics stack deploy ${t.status}\n--- logs (tail) ---\n${t.logs.slice(-3000)}`);
    }

    // Loopback-target regression: the pod's public IP doesn't route back
    // to :9100/:9400 from inside (only SSH is port-mapped), so prometheus
    // must scrape 127.0.0.1 and both targets must come up.
    let stdout = "";
    let up = 0;
    const deadline = Date.now() + 2 * 60 * 1000;
    while (Date.now() < deadline) {
      stdout = await exec(
        [
          'echo === prom-ready ; curl -sf -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:9090/-/ready',
          'echo === grafana-health ; curl -sf -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:3000/api/health',
          'echo === up-targets ; curl -sf http://127.0.0.1:9090/api/v1/targets | python3 -c "import json,sys; d=json.load(sys.stdin); ts=[t for t in d[\\"data\\"][\\"activeTargets\\"] if t[\\"health\\"]==\\"up\\"]; print(len(ts)); [print(t[\\"scrapeUrl\\"]) for t in ts]"',
        ].join(" ; "),
      );
      const m = stdout.match(/=== up-targets\s+(\d+)/);
      up = m ? Number(m[1]) : 0;
      if (up >= 2) break;
      await new Promise((res) => setTimeout(res, 10_000));
    }
    expect(stdout, `probe output:\n${stdout}`).toMatch(/=== prom-ready\s+200/);
    expect(stdout).toMatch(/=== grafana-health\s+200/);
    expect(up, `expected node (9100) + gpu (9400) targets up; probe:\n${stdout}`).toBeGreaterThanOrEqual(2);
    expect(stdout, "scrape targets must use loopback on a single-node pod").toMatch(/127\.0\.0\.1:9100/);
    expect(stdout).toMatch(/127\.0\.0\.1:9400/);
  }, 25 * 60 * 1000);

  // ─── 14. Delete cluster → terminates the rented pod ─────────────────
  it("deletes the cluster (terminating the RunPod pod)", async () => {
    const r = await api<{ success?: boolean }>("DELETE", `/api/clusters/${state.clusterId}`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.success).toBe(true);
    state.deleted = true;
  }, 5 * 60 * 1000);
});
