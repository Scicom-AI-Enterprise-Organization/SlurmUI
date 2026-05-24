/**
 * End-to-end regression suite that drives a fresh multipass-backed Slurm
 * cluster through the full Aura provisioning + operate flow, exercising
 * the public HTTP API as the only entrypoint.
 *
 * Run via:
 *   ./scripts/regression-test-multipass.sh
 *
 * That bash wrapper spins up the multipass VMs, writes the connection
 * details to $AURA_REGRESSION_ENV (a JSON file), then `npm run -s
 * test:e2e:multipass`. This file picks the env JSON up and walks through:
 *
 *   1. upload SSH key      → POST /api/admin/ssh-keys
 *   2. create cluster       → POST /api/clusters
 *   3. bootstrap            → POST /api/v1/clusters/:id/bootstrap
 *   4. verify main partition exists
 *   5. add worker 1         → POST /api/v1/clusters/:id/nodes
 *   6. add worker 2
 *   7. add NFS server entry to config
 *   8. deploy NFS server   → POST /api/v1/clusters/:id/storage/nfs-servers
 *   9. add storage_mounts entry to config (referencing the NFS server)
 *  10. deploy mount        → POST /api/v1/clusters/:id/storage/mounts
 *  11. install pandas      → POST /api/v1/clusters/:id/python-packages
 *  12. submit pandas job   → POST /api/v1/clusters/:id/jobs
 *  13. poll job to COMPLETED
 *  14. install metrics agents on every node
 *  15. deploy Prometheus + Grafana stack
 *  16. verify Prometheus is scraping + Grafana healthy
 *  17. teardown
 *
 * Each step is a `it()` block so the report shows per-stage status.
 * Tests share state via the module-scoped `state` object — the order
 * matters and Vitest is configured to run them sequentially (see
 * vitest.config.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";

// ──────────────────────────────────────────────────────────────────────
// Env JSON — written by scripts/regression-test-multipass.sh
// ──────────────────────────────────────────────────────────────────────
interface NodeInfo { name: string; ip: string; sshUser: string }
interface RegressEnv {
  base: string;
  token: string;
  master: NodeInfo;
  workers: NodeInfo[];
  jump: NodeInfo;
  keyPath: string;
  clusterName: string;
}
const envPath = process.env.AURA_REGRESSION_ENV;
if (!envPath) throw new Error("AURA_REGRESSION_ENV env var is required (path to the JSON written by regression-test-multipass.sh)");
const env: RegressEnv = JSON.parse(readFileSync(envPath, "utf8"));
const privateKey = readFileSync(env.keyPath, "utf8");

// ──────────────────────────────────────────────────────────────────────
// HTTP helpers — every call carries the Bearer admin token.
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

// Most v1 endpoints return { kind: "task", status: "success" | "failed", logs, durationMs }.
// `expectTaskOk` is the standard assertion: 200 + success + non-empty logs.
function expectTaskOk(resp: { status: number; data: any }, what: string) {
  if (resp.status !== 200 || resp.data?.status !== "success") {
    // Truncate logs so the Vitest failure box doesn't print 50k chars.
    const logs = String(resp.data?.logs ?? "").slice(-3000);
    throw new Error(
      `${what} failed (http=${resp.status}, status=${resp.data?.status}, error=${resp.data?.error ?? ""})\n--- logs (tail) ---\n${logs}`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// Shared cluster state — populated by the early `it()` blocks, read by
// the later ones. Vitest's sequential mode means later tests are skipped
// if an earlier one fails, so undefined-access shouldn't happen in
// practice, but the bangs make intent explicit.
// ──────────────────────────────────────────────────────────────────────
const state: {
  sshKeyId?: string;
  clusterId?: string;
  /**
   * Hostname of the master AS IT APPEARS IN `cluster.config.slurm_hosts_entries`
   * (i.e. the `hostname` the controller reports during seedControllerAsNode).
   * Resolved at runtime from the API rather than assumed from env, because
   * bootstrap may pick up the FQDN or a system-default if the VM was
   * renamed. The NFS-server lookup matches on hostname exactly, so getting
   * this right is what unblocks the storage flow.
   */
  masterHostname?: string;
  /** Aura user ID owning the Bearer token — needed to provision a Linux
   *  user on the cluster before any job submits. */
  selfUserId?: string;
  nfsServerId: string;
  mountId: string;
} = {
  // We don't have a UUID generator handy and we always overwrite cluster
  // config wholesale, so static ids are fine.
  nfsServerId: "regress-nfs-1",
  mountId: "regress-mnt-1",
};

const MOUNT_PATH = "/mnt/aura-regress-shared";
const VENV_PATH = "/opt/aura-venv";

describe("multipass cluster regression", () => {
  beforeAll(() => {
    console.log(`[regress] using cluster name: ${env.clusterName}`);
    console.log(`[regress] master: ${env.master.name} (${env.master.ip})`);
    console.log(`[regress] workers: ${env.workers.map((w) => `${w.name} (${w.ip})`).join(", ")}`);
  });

  afterAll(async () => {
    // Best-effort cleanup so re-runs don't pile up cluster rows. The bash
    // wrapper handles multipass-side cleanup; we just clear the Aura DB
    // record. Don't throw — failures here shouldn't mask suite results.
    if (!state.clusterId) return;
    console.log(`[regress] afterAll cleanup → teardown + delete cluster ${state.clusterId}`);
    try { await api("POST", `/api/clusters/${state.clusterId}/teardown`, {}); } catch {}
    try { await api("DELETE", `/api/clusters/${state.clusterId}`); } catch {}
  });

  // ─── 1. Upload SSH key ───────────────────────────────────────────────
  it("uploads the multipass SSH private key", async () => {
    const name = `${env.clusterName}-key`;
    const r = await api<{ id: string; name: string }>("POST", "/api/admin/ssh-keys", {
      name,
      privateKey,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.id).toBeTruthy();
    state.sshKeyId = r.data.id;
  });

  // ─── 2. Create cluster ───────────────────────────────────────────────
  it("creates the cluster row", async () => {
    const r = await api<{ id: string; name: string }>("POST", "/api/clusters", {
      name: env.clusterName,
      controllerHost: env.master.ip,
      connectionMode: "SSH",
      sshKeyId: state.sshKeyId,
      sshUser: env.master.sshUser, // "ubuntu" for multipass VMs
      sshPort: 22,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.id).toBeTruthy();
    state.clusterId = r.data.id;
  });

  // ─── 3. Bootstrap ────────────────────────────────────────────────────
  it("bootstraps the master (installs Slurm, slurmd, munge, mariadb)", async () => {
    const r = await api<{ logs?: string }>("POST", `/api/v1/clusters/${state.clusterId}/bootstrap`, {});
    expectTaskOk(r, "bootstrap");
    // Grep for seed-related lines so we can diagnose a controller that
    // doesn't end up in slurm_hosts_entries after a "successful" bootstrap.
    const seedLines = String(r.data.logs ?? "").split("\n").filter((l) => /seed|Controller|hostname=|MARKER/i.test(l));
    if (seedLines.length > 0) {
      console.log(`[regress] bootstrap seed lines:\n  ${seedLines.join("\n  ")}`);
    }
  }, 15 * 60 * 1000);

  // ─── 4. Verify default partition exists ──────────────────────────────
  it("auto-seeds a default 'main' partition during bootstrap", async () => {
    const r = await api<{ config: any }>("GET", `/api/clusters/${state.clusterId}`);
    expect(r.status).toBe(200);
    const parts = (r.data.config?.slurm_partitions ?? []) as Array<{ name: string; default?: boolean }>;
    expect(parts.length, `expected at least one partition; got ${JSON.stringify(parts)}`).toBeGreaterThan(0);
    expect(parts.find((p) => p.name === "main")).toBeTruthy();
    // Dump the cluster.config snapshot we observed right after bootstrap so
    // any later "master not in slurm_hosts_entries" failure can be diagnosed
    // against this baseline (did bootstrap fail to seed, or did a later
    // step wipe it?).
    console.log(`[regress] post-bootstrap config keys: ${Object.keys(r.data.config ?? {}).sort().join(", ")}`);
    console.log(`[regress] post-bootstrap slurm_hosts_entries: ${JSON.stringify(r.data.config?.slurm_hosts_entries ?? [], null, 2)}`);
    console.log(`[regress] post-bootstrap slurm_nodes: ${JSON.stringify(r.data.config?.slurm_nodes ?? [], null, 2)}`);
  });

  // ─── 5 & 6. Add the two worker nodes ─────────────────────────────────
  for (const [idx, w] of env.workers.entries()) {
    it(`adds worker ${idx + 1} (${w.name}) to the cluster`, async () => {
      const r = await api("POST", `/api/v1/clusters/${state.clusterId}/nodes`, {
        nodeName: w.name,
        ip: w.ip,
        sshUser: w.sshUser,
        cpus: 2,
        gpus: 0,
        memoryMb: 1800,
      });
      expectTaskOk(r, `add-node ${w.name}`);
    }, 15 * 60 * 1000);
  }

  // ─── 6.5. Resolve master hostname from slurm_hosts_entries ───────────
  // The NFS-server endpoint matches `hostNode` against the literal
  // `hostname` field in cluster.config.slurm_hosts_entries (populated by
  // seedControllerAsNode during bootstrap). On multipass VMs the VM name
  // and hostname agree, but we can't assume that in general — read
  // the real value back from the API so the test is portable.
  it("resolves the controller's hostname from cluster config", async () => {
    const r = await api<{ config: any }>("GET", `/api/clusters/${state.clusterId}`);
    expect(r.status).toBe(200);
    const hosts = (r.data.config?.slurm_hosts_entries ?? []) as Array<{ hostname: string; ip: string }>;
    // Log the full config snapshot so any future "master not found" failure
    // surfaces exactly what bootstrap actually persisted.
    console.log(`[regress] slurm_hosts_entries after bootstrap: ${JSON.stringify(hosts, null, 2)}`);
    console.log(`[regress] looking for master IP: ${env.master.ip}`);
    // Match either by IP (the address the cluster was created with) or by
    // hostname-equals-VM-name (since seedControllerAsNode writes whatever
    // `hostname` reports inside the VM, which == VM name on multipass).
    const masterEntry =
      hosts.find((h) => h.ip === env.master.ip) ??
      hosts.find((h) => h.hostname === env.master.name);
    expect(masterEntry, `master IP=${env.master.ip} / name=${env.master.name} not in ${JSON.stringify(hosts)}`).toBeTruthy();
    state.masterHostname = masterEntry!.hostname;
    console.log(`[regress] resolved master hostname: ${state.masterHostname}`);
  });

  // ─── 7. Add nfs_servers config entry ─────────────────────────────────
  it("registers an NFS-server entry in cluster.config", async () => {
    const get = await api<{ config: any }>("GET", `/api/clusters/${state.clusterId}`);
    const config = { ...(get.data.config ?? {}) };
    config.nfs_servers = [{
      id: state.nfsServerId,
      hostNode: state.masterHostname,
      exportPath: "/srv/aura-regress",
      allowedNetwork: "*",
    }];
    const patch = await api("PATCH", `/api/clusters/${state.clusterId}`, { config });
    expect(patch.status, JSON.stringify(patch.data)).toBe(200);
  });

  // ─── 8. Deploy the NFS server on the master ──────────────────────────
  it("provisions the self-hosted NFS server", async () => {
    const r = await api("POST", `/api/v1/clusters/${state.clusterId}/storage/nfs-servers`, {
      server: {
        id: state.nfsServerId,
        hostNode: state.masterHostname,
        exportPath: "/srv/aura-regress",
        allowedNetwork: "*",
      },
    });
    expectTaskOk(r, "nfs-server deploy");
  }, 10 * 60 * 1000);

  // ─── 9. Add storage_mounts config entry ──────────────────────────────
  it("registers an NFS mount entry in cluster.config", async () => {
    const get = await api<{ config: any }>("GET", `/api/clusters/${state.clusterId}`);
    const config = { ...(get.data.config ?? {}) };
    // Keep any pre-existing mounts (none in our case) and append ours.
    config.storage_mounts = [
      ...(config.storage_mounts ?? []),
      {
        id: state.mountId,
        type: "nfs",
        mountPath: MOUNT_PATH,
        nfsServerId: state.nfsServerId,
      },
    ];
    const patch = await api("PATCH", `/api/clusters/${state.clusterId}`, { config });
    expect(patch.status, JSON.stringify(patch.data)).toBe(200);
  });

  // ─── 10. Mount the NFS export on every node ──────────────────────────
  it("attaches the NFS mount on master + every worker", async () => {
    const r = await api("POST", `/api/v1/clusters/${state.clusterId}/storage/mounts`, {
      mount: {
        id: state.mountId,
        type: "nfs",
        mountPath: MOUNT_PATH,
        nfsServerId: state.nfsServerId,
      },
    });
    expectTaskOk(r, "storage/mounts deploy");
  }, 10 * 60 * 1000);

  // ─── 10.5. Provision the Bearer token's owner as a Linux user ───────
  // Job submit runs as the requesting Aura user's *Linux* identity, so we
  // need a matching Linux account on every node first. /api/v1/.../users
  // creates the uid + adds it via the per-host fan-out the admin Users
  // tab uses. Resolves the user id via /api/me first.
  it("provisions the Bearer-token owner as a Linux user on every node", async () => {
    // /api/me wraps the user record under .user (also exposes clusters,
    // stats, hasPassword) — pull the id from there.
    const me = await api<{ user: { id: string } }>("GET", "/api/me");
    expect(me.status, JSON.stringify(me.data)).toBe(200);
    expect(me.data.user?.id, `me payload: ${JSON.stringify(me.data)}`).toBeTruthy();
    state.selfUserId = me.data.user.id;

    const r = await api<{ ok?: boolean; error?: string }>("POST", `/api/v1/clusters/${state.clusterId}/users`, {
      userId: state.selfUserId,
    });
    // Provision is idempotent on Aura's side but the underlying handler
    // returns 409 ("User already provisioned to this cluster") if the
    // user is already wired up. Either 200/201 (fresh) or 409 (already
    // provisioned) is acceptable — what matters is the Linux account
    // landing on the controller.
    if (r.status !== 200 && r.status !== 201 && r.status !== 409) {
      throw new Error(`user provision failed: http=${r.status} body=${JSON.stringify(r.data)}`);
    }
  }, 5 * 60 * 1000);

  // ─── 11. Install pandas via the python-packages endpoint ─────────────
  it("installs pandas into /opt/aura-venv (per-node)", async () => {
    const r = await api("POST", `/api/v1/clusters/${state.clusterId}/python-packages`, {
      packages: [{ name: "pandas" }],
      installMode: "per-node",
      localVenvPath: VENV_PATH,
      pythonVersion: "3.12",
    });
    expectTaskOk(r, "pandas install");
  }, 15 * 60 * 1000);

  // ─── 12 & 13. Submit + poll a pandas job ─────────────────────────────
  it("runs a simple pandas job to completion", async () => {
    const script = [
      "#!/bin/bash",
      "#SBATCH --job-name=regress-pandas",
      "#SBATCH --partition=main",
      "#SBATCH --nodes=1",
      "#SBATCH --ntasks=1",
      "#SBATCH --mem=512M",
      "#SBATCH --time=00:05:00",
      `#SBATCH --chdir=${MOUNT_PATH}`,
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
    // POST /api/v1/clusters/:id/jobs returns 201 (Created) per REST
    // convention; older paths returned 200. Accept either.
    expect([200, 201], `unexpected status: ${sub.status}, body=${JSON.stringify(sub.data)}`).toContain(sub.status);
    const jobId = sub.data.id;

    // Poll up to 5 minutes for COMPLETED/FAILED/CANCELLED.
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

  // ─── 14. Install metrics exporters on every node ─────────────────────
  it("installs node_exporter + GPU exporter on every node", async () => {
    const r = await api("POST", `/api/v1/clusters/${state.clusterId}/metrics/install`, {});
    expectTaskOk(r, "metrics/install");
  }, 15 * 60 * 1000);

  // ─── 15. Deploy Prometheus + Grafana ─────────────────────────────────
  it("deploys the Prometheus + Grafana stack", async () => {
    const r = await api("POST", `/api/v1/clusters/${state.clusterId}/metrics/stack`, {});
    expectTaskOk(r, "metrics/stack deploy");
  }, 20 * 60 * 1000);

  // ─── 16. Probe Prometheus + Grafana health from inside the cluster ──
  it("Prometheus + Grafana respond to health probes from the cluster", async () => {
    // Prometheus' first scrape happens 15s after exporters are registered;
    // the stack deploy returns before that interval elapses. Poll for a
    // healthy target up to 60s so we don't false-fail the freshly-deployed
    // case.
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

  // ─── 17. Teardown — explicit so it shows up as its own check ────────
  it("tears down the cluster cleanly", async () => {
    const r = await api<{ exitCode?: number }>("POST", `/api/clusters/${state.clusterId}/teardown`, {});
    // The teardown endpoint streams via SSE; the JSON fallback returns
    // {exitCode: 0} on full success. Accept any 2xx + non-error payload.
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(500);
  }, 10 * 60 * 1000);
});
