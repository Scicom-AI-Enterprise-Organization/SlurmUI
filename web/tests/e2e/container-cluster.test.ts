/**
 * End-to-end regression for a CONTAINER-based cluster (managed-GPU shape).
 *
 * Single Ubuntu 24.04 Docker container, no systemd, CAP_SYS_ADMIN dropped
 * (default Docker capability set — matches Alibaba PAI-DSW, vast.ai,
 * runpod, etc.). The container is spun up by
 * scripts/spin-docker-container-cluster.sh which exports the connection
 * details into the JSON pointed at by AURA_REGRESSION_ENV.
 *
 * What differs from the multipass suite:
 *   - one-node cluster (the controller IS the only node)
 *   - bootstrap takes the pm2-go branch instead of systemd
 *   - NFS server self-hosting + mount attach are EXPECTED to fail
 *     (overlayfs root FS can't be kernel-NFS-exported AND mount() needs
 *     CAP_SYS_ADMIN which the container doesn't have) — we verify the
 *     endpoints surface that constraint with actionable errors rather
 *     than silently 500'ing.
 *   - metrics exporters + Prom + Grafana all need to come up under pm2.
 *
 * Run via:
 *   ./scripts/regression-test-container.sh
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";

interface ControllerInfo {
  host: string;
  port: number;
  sshUser: string;
}
interface RegressEnv {
  base: string;
  token: string;
  controller: ControllerInfo;
  keyPath: string;
  containerName: string;
  capBnd: string;
  clusterName: string;
}

const envPath = process.env.AURA_REGRESSION_ENV;
if (!envPath) throw new Error("AURA_REGRESSION_ENV env var is required (path to the JSON written by regression-test-container.sh)");
const env: RegressEnv = JSON.parse(readFileSync(envPath, "utf8"));
const privateKey = readFileSync(env.keyPath, "utf8");

// ──────────────────────────────────────────────────────────────────────
// HTTP helpers (same shape as the multipass suite).
// ──────────────────────────────────────────────────────────────────────
type Json = Record<string, unknown>;
async function api<T = Json>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<{ status: number; data: T }> {
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

function expectTaskOk(resp: { status: number; data: any }, what: string) {
  if (resp.status !== 200 || resp.data?.status !== "success") {
    const logs = String(resp.data?.logs ?? "").slice(-3000);
    throw new Error(
      `${what} failed (http=${resp.status}, status=${resp.data?.status}, error=${resp.data?.error ?? ""})\n--- logs (tail) ---\n${logs}`,
    );
  }
}

const state: {
  sshKeyId?: string;
  clusterId?: string;
  /** The hostname seedControllerAsNode wrote to slurm_hosts_entries —
   *  inside a Docker container that's the autogen ID like `c0a8b1d2…`. */
  masterHostname?: string;
  selfUserId?: string;
} = {};

const VENV_PATH = "/opt/aura-venv";

describe("container cluster regression (managed-GPU shape)", () => {
  beforeAll(() => {
    console.log(`[regress] using cluster name: ${env.clusterName}`);
    console.log(`[regress] controller: ${env.controller.sshUser}@${env.controller.host}:${env.controller.port}`);
    console.log(`[regress] CapBnd:      ${env.capBnd}`);
  });

  afterAll(async () => {
    if (!state.clusterId) return;
    console.log(`[regress] afterAll cleanup → teardown + delete cluster ${state.clusterId}`);
    try { await api("POST", `/api/clusters/${state.clusterId}/teardown`, {}); } catch {}
    try { await api("DELETE", `/api/clusters/${state.clusterId}`); } catch {}
  });

  // ─── 1. Sanity-check the cap set is the one we want to test against ──
  // If the spin script's container picks up extra caps (unusual host
  // config, --cap-add), the rest of the suite stops being a faithful
  // mimic of the GPU-container scenario and the "expect mount to fail"
  // assertions would mislead us.
  it("container has the managed-GPU cap set (CAP_SYS_ADMIN dropped)", () => {
    // Bottom 16 bits of CapBnd encode CHOWN/DAC_OVERRIDE/etc. — they're
    // common to all unprivileged containers. The bit that determines
    // mount() vs no-mount() is CAP_SYS_ADMIN (bit 21). The reference
    // GPU container reports a80425fb where bit 21 is 0. Just check
    // that bit explicitly instead of matching the whole bitmask
    // verbatim (so a different distro variant that adds CAP_AUDIT_WRITE
    // or similar isn't a false negative).
    const cap = BigInt("0x" + env.capBnd);
    const SYS_ADMIN = 21n;
    expect((cap >> SYS_ADMIN) & 1n, `unexpected CAP_SYS_ADMIN granted; CapBnd=${env.capBnd}`).toBe(0n);
  });

  // ─── 2. Upload SSH key ───────────────────────────────────────────────
  it("uploads the container SSH private key", async () => {
    const name = `${env.clusterName}-key`;
    const r = await api<{ id: string; name: string }>("POST", "/api/admin/ssh-keys", {
      name,
      privateKey,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    state.sshKeyId = r.data.id;
  });

  // ─── 3. Create cluster ───────────────────────────────────────────────
  it("creates the cluster row pointing at the container", async () => {
    const r = await api<{ id: string }>("POST", "/api/clusters", {
      name: env.clusterName,
      controllerHost: env.controller.host,
      connectionMode: "SSH",
      sshKeyId: state.sshKeyId,
      sshUser: env.controller.sshUser,
      sshPort: env.controller.port,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    state.clusterId = r.data.id;
  });

  // ─── 4. Bootstrap (pm2-go path) ──────────────────────────────────────
  // The bootstrap probes /run/systemd/system, sees it's absent, installs
  // pm2-go, and supervises slurmctld/slurmd/munge/mariadb under pm2.
  // This is the longest step of the suite — ~5-10 min cold, ~30s warm.
  it("bootstraps the container (no systemd → pm2-go branch)", async () => {
    const r = await api<{ status: string; stdout?: string; stderr?: string; seedDiagnostic?: string }>(
      "POST",
      `/api/v1/clusters/${state.clusterId}/bootstrap`,
      {},
    );
    if (r.status !== 200 || r.data.status !== "success") {
      throw new Error(
        `bootstrap failed (http=${r.status}, status=${r.data.status}, seed=${r.data.seedDiagnostic ?? "-"})\n--- stderr tail ---\n${(r.data.stderr ?? "").slice(-2000)}`,
      );
    }
    if (r.data.seedDiagnostic) {
      console.log(`[regress] seedDiagnostic: ${r.data.seedDiagnostic}`);
    }
  }, 20 * 60 * 1000);

  // ─── 5. Verify partition + controller-as-node seeding ────────────────
  it("auto-seeds 'main' partition and registers the controller as a node", async () => {
    const r = await api<{ config: any }>("GET", `/api/clusters/${state.clusterId}`);
    expect(r.status).toBe(200);
    const cfg = r.data.config ?? {};
    const parts = (cfg.slurm_partitions ?? []) as Array<{ name: string }>;
    expect(parts.find((p) => p.name === "main"), `partitions=${JSON.stringify(parts)}`).toBeTruthy();

    const hosts = (cfg.slurm_hosts_entries ?? []) as Array<{ hostname: string; ip: string }>;
    console.log(`[regress] slurm_hosts_entries: ${JSON.stringify(hosts)}`);
    expect(hosts.length, `expected at least the controller in slurm_hosts_entries`).toBeGreaterThan(0);
    state.masterHostname = hosts[0].hostname;
  });

  // ─── 6. Storage endpoints surface the cap constraint cleanly ─────────
  // We do NOT want a silent 500. The deploy scripts probe FS type / cap
  // set up-front and exit 17/18 with an actionable error. Verify the
  // wrapper turns that into a failed task whose log contains the hint —
  // exactly what production users will see.
  it("NFS-server provisioning surfaces overlayfs/cap-set error cleanly", async () => {
    // First PATCH cluster config so the endpoint can find a server entry
    // to deploy. The deploy itself is what we expect to fail.
    const get = await api<{ config: any }>("GET", `/api/clusters/${state.clusterId}`);
    const config = { ...(get.data.config ?? {}) };
    config.nfs_servers = [{
      id: "ctr-nfs-1",
      hostNode: state.masterHostname,
      exportPath: "/srv/aura-ctr-regress",
      allowedNetwork: "*",
    }];
    await api("PATCH", `/api/clusters/${state.clusterId}`, { config });

    const r = await api<{ status: string; logs?: string }>(
      "POST",
      `/api/v1/clusters/${state.clusterId}/storage/nfs-servers`,
      { server: config.nfs_servers[0] },
    );
    expect(r.data.status, JSON.stringify(r.data).slice(0, 300)).toBe("failed");
    const logs = r.data.logs ?? "";
    // The actionable hint should mention overlayfs OR the cap-set, not
    // a raw exportfs / kernel error.
    expect(
      logs,
      `expected diagnostic about overlayfs / kernel NFS unsupported; logs:\n${logs.slice(-1200)}`,
    ).toMatch(/overlayfs|aufs|cannot be NFS-exported|kernel NFS|container/i);
  }, 5 * 60 * 1000);

  // ─── 7. Provision the Bearer-token owner as a Linux user ────────────
  it("provisions the Bearer-token owner as a Linux user", async () => {
    const me = await api<{ user: { id: string } }>("GET", "/api/me");
    expect(me.status, JSON.stringify(me.data)).toBe(200);
    state.selfUserId = me.data.user.id;

    const r = await api<{ ok?: boolean; error?: string }>(
      "POST",
      `/api/v1/clusters/${state.clusterId}/users`,
      { userId: state.selfUserId },
    );
    if (r.status !== 200 && r.status !== 201 && r.status !== 409) {
      throw new Error(`user provision failed: http=${r.status} body=${JSON.stringify(r.data)}`);
    }
  }, 5 * 60 * 1000);

  // ─── 8. Install pandas (per-node, /opt/aura-venv) ────────────────────
  it("installs pandas into /opt/aura-venv (per-node)", async () => {
    const r = await api("POST", `/api/v1/clusters/${state.clusterId}/python-packages`, {
      packages: [{ name: "pandas" }],
      installMode: "per-node",
      localVenvPath: VENV_PATH,
      pythonVersion: "3.12",
    });
    expectTaskOk(r, "pandas install");
  }, 15 * 60 * 1000);

  // ─── 9. Submit + poll a pandas job ───────────────────────────────────
  it("runs a simple pandas job to completion", async () => {
    const script = [
      "#!/bin/bash",
      "#SBATCH --job-name=ctr-regress-pandas",
      "#SBATCH --partition=main",
      "#SBATCH --nodes=1",
      "#SBATCH --ntasks=1",
      "#SBATCH --mem=256M",
      "#SBATCH --time=00:05:00",
      "",
      `source ${VENV_PATH}/bin/activate`,
      "python3 - <<'PY'",
      "import pandas as pd",
      'df = pd.DataFrame({"a": [1, 2, 3], "b": [10, 20, 30]})',
      'print("sum:", int(df["a"].sum() + df["b"].sum()))',
      'print("pandas:", pd.__version__)',
      "PY",
    ].join("\n");

    const sub = await api<{ id: string; slurmJobId: number }>(
      "POST",
      `/api/v1/clusters/${state.clusterId}/jobs`,
      { script },
    );
    expect([200, 201], `unexpected status: ${sub.status} body=${JSON.stringify(sub.data)}`).toContain(sub.status);
    const jobId = sub.data.id;

    const deadline = Date.now() + 5 * 60 * 1000;
    let last: any = {};
    while (Date.now() < deadline) {
      const r = await api<{ job: any }>("GET", `/api/v1/jobs/${jobId}`);
      last = r.data?.job ?? {};
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(last.status)) break;
      await new Promise((res) => setTimeout(res, 3000));
    }
    expect(last.status, `job did not finish in time: ${JSON.stringify(last)}`).toBe("COMPLETED");
  }, 8 * 60 * 1000);

  // ─── 10. Metrics exporters (pm2-supervised) ──────────────────────────
  it("installs node_exporter + GPU exporter under pm2", async () => {
    const r = await api<{ logs?: string }>("POST", `/api/v1/clusters/${state.clusterId}/metrics/install`, {});
    expectTaskOk(r, "metrics/install");
    // The supervisor line is the canary that the container-aware branch
    // ran. Without it the install would have called systemctl and
    // silently no-op'd.
    expect(r.data.logs ?? "", `expected pm2 supervisor banner; logs tail:\n${(r.data.logs ?? "").slice(-1200)}`)
      .toMatch(/\[supervisor\][^\n]*pm2/);
  }, 15 * 60 * 1000);

  // ─── 11. Prom + Grafana stack (pm2-supervised) ───────────────────────
  it("deploys the Prometheus + Grafana stack under pm2", async () => {
    const r = await api<{ logs?: string }>("POST", `/api/v1/clusters/${state.clusterId}/metrics/stack`, {});
    expectTaskOk(r, "metrics/stack deploy");
    expect(r.data.logs ?? "", "expected pm2 supervisor in stack deploy logs")
      .toMatch(/\[supervisor\][^\n]*pm2/);
  }, 20 * 60 * 1000);

  // ─── 12. Health probe ───────────────────────────────────────────────
  it("Prometheus + Grafana respond to health probes from inside the container", async () => {
    let stdout = "";
    let targets = 0;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const probe = await api<{ stdout: string }>(
        "POST",
        `/api/v1/clusters/${state.clusterId}/exec`,
        { command: [
          'echo === prom-ready ; curl -sf -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:9090/-/ready',
          'echo === grafana-health ; curl -sf -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:3000/api/health',
          'echo === prom-targets ; curl -sf http://127.0.0.1:9090/api/v1/targets | python3 -c "import json,sys; d=json.load(sys.stdin); print(len([t for t in d[\\"data\\"][\\"activeTargets\\"] if t[\\"health\\"]==\\"up\\"]))"',
        ].join(" ; ") },
      );
      expect(probe.status).toBe(200);
      stdout = probe.data.stdout ?? "";
      const m = stdout.match(/=== prom-targets\s+(\d+)/);
      targets = m ? Number(m[1]) : 0;
      if (targets > 0) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect(stdout, `final probe output: ${stdout}`).toMatch(/=== prom-ready\s+200/);
    expect(stdout).toMatch(/=== grafana-health\s+200/);
    expect(targets, `prometheus has no healthy targets after 60s. stdout=${stdout}`).toBeGreaterThan(0);
  }, 120 * 1000);

  // ─── 13. Teardown ───────────────────────────────────────────────────
  it("tears down the cluster cleanly", async () => {
    const r = await api<{ exitCode?: number }>("POST", `/api/clusters/${state.clusterId}/teardown`, {});
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(500);
  }, 10 * 60 * 1000);
});
