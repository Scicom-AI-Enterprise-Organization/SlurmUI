/**
 * Unit tests for lib/job-list-transform.ts.
 *
 * Locks down the listing-payload perf contract: a typical Job row has
 * `script` (~1-2 KB) and `output` (cached stdout, can be MB) — the
 * listing endpoint must NEVER include either. The transform extracts
 * the SBATCH job-name from `script`, then drops both columns from
 * the response. If a future contributor accidentally re-adds them
 * (e.g. by selecting `script: true` for some other reason), this test
 * is the canary.
 *
 * Run with:
 *   node --import tsx --test --test-reporter=spec test/job-list-transform.unit.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { extractJobName, toJobListItem, toJobListItems } = await import(
  "../lib/job-list-transform.ts"
);

const baseRow = {
  id: "j1",
  slurmJobId: 100,
  clusterId: "c1",
  userId: "u1",
  partition: "gpu",
  status: "RUNNING",
  exitCode: null,
  createdAt: new Date("2026-05-05T00:00:00Z"),
  updatedAt: new Date("2026-05-05T00:01:00Z"),
  sourceName: null,
  script: "#!/bin/bash\n#SBATCH --job-name=hello-world\necho hi",
};

test("extractJobName matches --job-name=foo", () => {
  assert.equal(extractJobName("#SBATCH --job-name=test-1\n"), "test-1");
});

test("extractJobName matches -J foo (short flag with space)", () => {
  assert.equal(extractJobName("#SBATCH -J myjob\n"), "myjob");
});

test("extractJobName returns null when no SBATCH name directive", () => {
  assert.equal(extractJobName("#!/bin/bash\necho hi"), null);
});

test("extractJobName returns null on empty / null input", () => {
  assert.equal(extractJobName(""), null);
  assert.equal(extractJobName(null), null);
  assert.equal(extractJobName(undefined), null);
});

test("toJobListItem drops `script` after extracting the name", () => {
  const out = toJobListItem(baseRow);
  assert.equal(out.name, "hello-world");
  // Critical perf guard — `script` MUST NOT appear in the listing payload.
  assert.equal("script" in out, false, "script must be stripped from the listing item");
});

test("toJobListItem drops `output` even if it leaks in from a future select", () => {
  // Simulates a contributor forgetting and adding `output: true` to the
  // Prisma `select`. The transform's destructure-then-rebuild guards
  // against the extra field reaching the wire.
  const rowWithOutput = { ...baseRow, output: "x".repeat(5_000_000) }; // 5 MB
  const out = toJobListItem(rowWithOutput);
  assert.equal("output" in out, false, "output must be stripped from the listing item");
});

test("toJobListItem preserves the rendered table columns", () => {
  const out = toJobListItem(baseRow);
  for (const col of [
    "id", "slurmJobId", "clusterId", "userId", "partition",
    "status", "exitCode", "createdAt", "updatedAt", "sourceName", "name",
  ]) {
    assert.ok(col in out, `missing column ${col} in listing output`);
  }
});

test("toJobListItem is shape-stable — output keys are exactly the listing columns", () => {
  const out = toJobListItem(baseRow);
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, [
    "clusterId", "createdAt", "exitCode", "id", "name", "partition",
    "slurmJobId", "sourceName", "status", "updatedAt", "userId",
  ], "listing output keys drifted — confirm the wire shape is intentional");
});

test("toJobListItems maps over an array", () => {
  const out = toJobListItems([
    baseRow,
    { ...baseRow, id: "j2", script: "#SBATCH -J shorthand-name" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "hello-world");
  assert.equal(out[1].name, "shorthand-name");
});

test("a 5 MB row shrinks dramatically after transform (perf assertion)", () => {
  const fat = { ...baseRow, output: "x".repeat(5_000_000), script: baseRow.script + "y".repeat(2000) };
  const beforeBytes = JSON.stringify(fat).length;
  const afterBytes = JSON.stringify(toJobListItem(fat)).length;
  // Concrete numbers depend on the row, but the contract is "two-orders-
  // of-magnitude shrink when output is dominant". 100x is the canary;
  // bump it down only if the listing intentionally regrows.
  assert.ok(
    beforeBytes / afterBytes > 100,
    `expected >100x shrink, got ${beforeBytes}B → ${afterBytes}B (${(beforeBytes/afterBytes).toFixed(1)}x)`,
  );
});
