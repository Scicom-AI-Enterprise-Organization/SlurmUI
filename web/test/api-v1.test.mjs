/**
 * Integration tests for the /api/v1 public API.
 *
 * Runs against a live SlurmUI instance — it submits a real gloo-reduce
 * script, polls the job to completion, fetches its output, and checks
 * every response shape. Uses node:test so you can run it with plain
 * `node --test test/api-v1.test.mjs` — no extra dep.
 *
 * Usage:
 *   export AURA_BASE=http://localhost:3000         # defaults to this
 *   export AURA_TOKEN=aura_xxxxxxxxxxxxxxxxxxxxxxxx
 *   export AURA_CLUSTER=tm                         # name or uuid
 *   node --test --test-timeout=600000 test/api-v1.test.mjs
 *
 * The gloo-reduce script runs CPU-only, single node, finishes in <10s, so
 * a ~10 minute default timeout covers bastion latency + queue wait.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.AURA_BASE ?? "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.AURA_TOKEN;
const CLUSTER = process.env.AURA_CLUSTER;
if (!CLUSTER) {
  console.error("AURA_CLUSTER is required (cluster name or uuid)");
  process.exit(2);
}
const SUBMIT_TIMEOUT_MS = Number(process.env.AURA_TEST_TIMEOUT_MS ?? 10 * 60 * 1000);

if (!TOKEN) {
  console.error("AURA_TOKEN is required (see /profile/api-tokens)");
  process.exit(2);
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...auth,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return { _raw: text }; } })() : {};
  return { status: res.status, data };
}

// Context carried across tests (node:test runs them sequentially in file order).
const ctx = { jobId: null, slurmJobId: null };

before(async () => {
  // Smoke: base reachable.
  const r = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!r) throw new Error(`Cannot reach ${BASE} — is SlurmUI running?`);
});

test("GET /api/v1/clusters rejects missing token", async () => {
  const res = await fetch(`${BASE}/api/v1/clusters`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error, /Unauthorized/i);
});

test("GET /api/v1/clusters rejects bogus token", async () => {
  const res = await fetch(`${BASE}/api/v1/clusters`, {
    headers: { Authorization: "Bearer aura_not_a_real_token_zzzzz" },
  });
  assert.equal(res.status, 401);
});

test("GET /api/v1/clusters returns at least the target cluster", async () => {
  const { status, data } = await req("GET", "/api/v1/clusters");
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.clusters), "clusters should be an array");
  const match = data.clusters.find((c) => c.name === CLUSTER || c.id === CLUSTER);
  assert.ok(match, `cluster "${CLUSTER}" not found in /api/v1/clusters response`);
  assert.ok(match.partitions?.length >= 1, "cluster has no partitions — bootstrap / add a node first");
  console.log(`    • ${match.name} (${match.status}, mode=${match.mode}, parts=${match.partitions.join(",")})`);
});

test("GET /api/v1/clusters/:cluster/jobs — empty filters return paginated list", async () => {
  const { status, data } = await req("GET", `/api/v1/clusters/${encodeURIComponent(CLUSTER)}/jobs?limit=5`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.jobs));
  assert.ok(data.pagination && typeof data.pagination.total === "number");
  assert.ok(data.pagination.limit <= 5);
});

test("POST /api/v1/clusters/:cluster/jobs — reject empty script", async () => {
  const { status, data } = await req("POST", `/api/v1/clusters/${encodeURIComponent(CLUSTER)}/jobs`, {
    script: "",
  });
  assert.equal(status, 400);
  assert.match(data.error ?? "", /script/);
});

test("POST /api/v1/clusters/:cluster/jobs — unknown cluster is 404", async () => {
  const { status } = await req("POST", `/api/v1/clusters/definitely-not-a-real-cluster-xyz/jobs`, {
    script: "#!/bin/bash\nhostname",
  });
  assert.equal(status, 404);
});

test("POST /api/v1/clusters/:cluster/jobs — submit a Gloo all-reduce job", async () => {
  // Venv with torch is expected at /opt/aura-venv — configurable via env
  // so CI/other clusters can point at a different location (e.g. a shared
  // NFS mount). Activate before running the Python test.
  const VENV = process.env.AURA_TEST_VENV ?? "/opt/aura-venv";
  const script = [
    "#!/bin/bash",
    "#SBATCH --time=00:02:00",
    "#SBATCH --ntasks=1",
    "#SBATCH --cpus-per-task=2",
    "",
    "set -euo pipefail",
    "echo \"[gloo-test] host=$(hostname) job=$SLURM_JOB_ID\"",
    "",
    `# Activate the shared venv that carries torch. Overridable via`,
    `# AURA_TEST_VENV on the test runner side.`,
    `if [ -f "${VENV}/bin/activate" ]; then`,
    `  source "${VENV}/bin/activate"`,
    `  echo "[gloo-test] activated venv at ${VENV} (python=$(command -v python3))"`,
    `else`,
    `  echo "[gloo-test] WARN: no venv at ${VENV}; using system python3"`,
    `fi`,
    "",
    "# Tiny self-contained gloo all-reduce using torch.distributed with a",
    "# single rank — exercises the backend without needing multiple nodes.",
    "python3 - <<'PY'",
    "import os, torch, torch.distributed as dist",
    "os.environ.setdefault('MASTER_ADDR', '127.0.0.1')",
    "os.environ.setdefault('MASTER_PORT', '29501')",
    "dist.init_process_group(backend='gloo', init_method='env://',",
    "                        world_size=1, rank=0)",
    "t = torch.tensor([1.0, 2.0, 3.0, 4.0])",
    "dist.all_reduce(t, op=dist.ReduceOp.SUM)",
    "print('[gloo-test] all_reduce result:', t.tolist())",
    "assert t.tolist() == [1.0, 2.0, 3.0, 4.0], 'single-rank sum must be identity'",
    "dist.destroy_process_group()",
    "print('[gloo-test] ok')",
    "PY",
  ].join("\n");

  const { status, data } = await req("POST", `/api/v1/clusters/${encodeURIComponent(CLUSTER)}/jobs`, {
    name: "api-test-gloo-reduce",
    script,
  });
  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(data)}`);
  assert.ok(data.id, "response missing id");
  assert.ok(data.slurmJobId, "response missing slurmJobId");
  assert.ok(["PENDING", "RUNNING"].includes(data.status), `unexpected initial status ${data.status}`);
  ctx.jobId = data.id;
  ctx.slurmJobId = data.slurmJobId;
  console.log(`    • submitted job.id=${data.id} slurmJobId=${data.slurmJobId}`);
});

test("GET /api/v1/jobs/:id — fetch metadata for the submitted job", async () => {
  assert.ok(ctx.jobId, "previous submit did not set jobId");
  const { status, data } = await req("GET", `/api/v1/jobs/${ctx.jobId}`);
  assert.equal(status, 200);
  assert.equal(data.job.id, ctx.jobId);
  assert.equal(data.job.slurmJobId, ctx.slurmJobId);
  assert.ok(data.job.createdAt);
});

test("GET /api/v1/jobs/:id — polls to a terminal status", async () => {
  assert.ok(ctx.jobId);
  const deadline = Date.now() + SUBMIT_TIMEOUT_MS;
  let last = "UNKNOWN";
  let lastResyncAt = 0;
  while (Date.now() < deadline) {
    const { status, data } = await req("GET", `/api/v1/jobs/${ctx.jobId}`);
    assert.equal(status, 200);
    last = data.job.status;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(last)) break;

    // Safety net: every 30 s of sitting in the same non-terminal state,
    // call the v1 resync endpoint. The tail-based job watcher can miss
    // terminal transitions (output file on an unmounted path, bastion
    // ssh drop mid-tail, etc.) and leave the row stuck on RUNNING even
    // after Slurm has finished. `resync` re-queries squeue + sacct.
    if (Date.now() - lastResyncAt > 30_000) {
      const r = await req("POST", `/api/v1/jobs/${ctx.jobId}/resync`);
      lastResyncAt = Date.now();
      if (r.status === 200 && r.data.next) last = r.data.next;
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(last)) break;
    }
    await sleep(3000);
  }
  console.log(`    • final status=${last}`);
  assert.ok(["COMPLETED", "FAILED", "CANCELLED"].includes(last), `job still ${last} after timeout`);
});

test("POST /api/v1/jobs/:id/resync — returns current Slurm state for a known job", async () => {
  assert.ok(ctx.jobId);
  const { status, data } = await req("POST", `/api/v1/jobs/${ctx.jobId}/resync`);
  assert.equal(status, 200);
  // `next` is filled when Slurm knows the job; `error` is filled when
  // accounting is unavailable / job expired. Exactly one must be present.
  assert.ok(data.next || data.error, "resync should yield either next-state or error");
  if (data.next) {
    assert.ok(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(data.next));
  }
});

test("GET /api/v1/jobs/:id?output=1 — returns output tail", async () => {
  assert.ok(ctx.jobId);
  const { status, data } = await req("GET", `/api/v1/jobs/${ctx.jobId}?output=1`);
  assert.equal(status, 200);
  // Output may be null on clusters without SSH, but for bastion/SSH it
  // should be a string; outputSize should be a number either way.
  assert.equal(typeof data.outputSize, "number");
  if (data.output != null) {
    assert.equal(typeof data.output, "string");
    // Log a short preview so test output is human-readable
    const preview = data.output.split("\n").slice(-5).join("\n");
    console.log(`    • last lines:\n${preview.split("\n").map((l) => "      " + l).join("\n")}`);
  }
});

test("GET /api/v1/jobs/:id — unknown id is 404", async () => {
  const { status } = await req("GET", `/api/v1/jobs/00000000-0000-0000-0000-000000000000`);
  assert.equal(status, 404);
});

test("GET /api/v1/clusters/:cluster/jobs — new job is discoverable via list", async () => {
  const { status, data } = await req("GET", `/api/v1/clusters/${encodeURIComponent(CLUSTER)}/jobs?limit=50`);
  assert.equal(status, 200);
  const found = data.jobs.find((j) => j.id === ctx.jobId);
  assert.ok(found, "submitted job not present in list endpoint");
});

test("GET /api/v1/clusters/:cluster/jobs — status filter is enforced", async () => {
  const terminal = await req("GET", `/api/v1/clusters/${encodeURIComponent(CLUSTER)}/jobs?status=COMPLETED&limit=50`);
  assert.equal(terminal.status, 200);
  for (const j of terminal.data.jobs) {
    assert.equal(j.status, "COMPLETED");
  }
});

test("POST /api/v1/jobs/:id/cancel — clean up the test job", async () => {
  if (!ctx.jobId) return;
  // Only cancel if it's still active. Already-terminal rows just short-circuit.
  const { data: before } = await req("GET", `/api/v1/jobs/${ctx.jobId}`);
  if (!before?.job || ["COMPLETED", "FAILED", "CANCELLED"].includes(before.job.status)) {
    return;
  }
  const { status, data } = await req("POST", `/api/v1/jobs/${ctx.jobId}/cancel`);
  assert.equal(status, 200);
  assert.equal(data.status, "CANCELLED");
});

after(() => {
  console.log(`\ndone — jobId=${ctx.jobId} slurmJobId=${ctx.slurmJobId}`);
});
