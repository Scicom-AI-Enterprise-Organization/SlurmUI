# Tests

Two layers, both runnable with plain `node --test` — no Jest, no Vitest, no extra deps.

| Layer | What it covers | Needs a server? | Speed |
|---|---|---|---|
| Unit (`*.unit.test.mjs`) | Pure logic — token helpers, proxy rewrite regex, role-cache TTL, listing transform, scheduler. | No. | ~5 s total |
| Mock-mode (`job-proxy.smoke.test.mjs` default) | Spins a tiny in-process HTTP+WS upstream, exercises proxy rewriters end-to-end. | No. | ~5 s |
| Live-mode (`job-proxy.smoke.test.mjs` with env) | Drives the running Aura proxy against a real cluster job. | Yes — running web + a job with a proxy port. | ~10 s |
| Integration (`api-v1.test.mjs`) | End-to-end against `/api/v1` — auth gates, submit, list, restart, cancel, output. | Yes — running web + cluster + Slurm. | ~10 min |

The unit + mock layers are CI-friendly. Live + integration are run manually before a release.

## Run everything

```bash
cd web

# Unit + mock tests (no infra). Ship-blocker for every PR.
node --import tsx --test --test-reporter=spec \
  test/api-auth.unit.test.mjs \
  test/job-proxy-rewrite.unit.test.mjs \
  test/job-list-transform.unit.test.mjs \
  test/role-cache.unit.test.mjs \
  test/visible-interval-scheduler.unit.test.mjs \
  test/job-proxy.smoke.test.mjs

# Or just one file:
node --import tsx --test --test-reporter=spec test/role-cache.unit.test.mjs
```

Expected on green: `76 pass, 3 skipped (live-only)`.

## Per-file rundown

### `api-auth.unit.test.mjs`

Token shape, hash determinism, prefix consistency, 1000-iter uniqueness, no
silent whitespace trimming. Covers `lib/api-auth.ts` helpers used by the
`/api/v1` Bearer-token auth.

### `job-proxy-rewrite.unit.test.mjs`

Pure helpers in `lib/job-proxy-rewrite.ts`: prefix strip, parseCookies,
`safeCloseCode` (1005/1006 → 1000), HTML rewriter (incl. `<script>`/`<style>`
opening-tag attribute rewrite, body left alone for CSP-pinned hashes),
OpenAPI 3.x `servers` injection, Swagger 2.0 `basePath`/`host`,
Set-Cookie path rewrite, Location rewrite, hop-by-hop sets,
`<base href="…">` injection (insert / replace / no-`<head>` fallback).

The HTML-rewriter idempotency case caught a real regex bug while writing
the tests — the lookahead was anchored on the wrong position and
already-prefixed paths would get re-prefixed.

### `job-proxy.smoke.test.mjs`

Two modes, controlled by env:

| Env vars set? | Mode | What runs |
|---|---|---|
| None | **Mock** (default) | Spins a fake upstream HTTP+WS server in-process, exercises the rewrite helpers against realistic responses (302, OpenAPI JSON, HTML, multi-Set-Cookie, WS echo). |
| All set | **Live** | Drives the real running proxy at `$AURA_PROXY_BASE`. Needs a job with a proxy port configured. |

Live env vars (all required for live mode):

```bash
AURA_PROXY_BASE=http://localhost:3000           # default
AURA_PROXY_CLUSTER=<cluster-uuid>
AURA_PROXY_JOB=<job-uuid>
AURA_SESSION_COOKIE='authjs.session-token=…'
```

Live tests verify the WS bridge's actual handshake (`OPEN ✓ → kernel_info_request →
status response → close 1000`), the diagnostic response headers, and the
1005/1006-doesn't-crash regression that bit us once.

### `role-cache.unit.test.mjs` — perf canary

Pins the TTL contract on `lib/role-cache.ts`. The cache is what lets the
NextAuth jwt callback dedupe parallel `User.findUnique` calls — without
it, every authenticated API call pays a Postgres round-trip for the
`role` column on every parallel request.

The "5 parallel reads → 1 DB hit" assertion is the direct canary; if it
goes red, we've regressed back to N+1 lookups on every authenticated
page load.

### `job-list-transform.unit.test.mjs` — perf canary

Pins the listing payload contract on `lib/job-list-transform.ts`. The
listing endpoint MUST drop `script` (~1-2 KB/row) after extracting the
SBATCH job-name and MUST never include `output` (cached job stdout, can
be MB/row).

The "5 MB row → >100× shrink" assertion is the direct canary. If it
trips, somebody added `output: true` (or removed the destructure guard)
and the listing payload is regrowing.

### `visible-interval-scheduler.unit.test.mjs` — perf canary

Pins the pause-on-hidden contract on `lib/visible-interval-scheduler.ts`.
The jobs page's `/resources` auto-refresh is SSH-driven; running it in
hidden tabs costs 1-3 s of bastion SSH per 30-second tick per tab — pure
waste.

The "typical hidden→visible→hidden cycle counts" test is the direct
canary; if `pause()` starts firing `fn`, we've regressed.

### `api-v1.test.mjs` — full integration

Runs against a live SlurmUI; submits a real Gloo all-reduce script,
polls to terminal, fetches output, exercises the restart + cancel
paths.

```bash
export AURA_BASE=http://localhost:3000
export AURA_TOKEN=aura_…              # mint at /profile/api-tokens
export AURA_CLUSTER=tm                # name or uuid
node --import tsx --test --test-reporter=spec --test-timeout=600000 test/api-v1.test.mjs
```

10-minute default timeout covers bastion SSH latency + queue wait. Skip
in CI; run before releases.

## Speed benchmarking

Three layers of "did I actually make it faster":

### 1. Unit-level perf canaries (this directory)

The three `*.unit.test.mjs` files marked **perf canary** above each
contain one assertion that fails fast if the corresponding speed change
regresses. They run in <1 s combined and have no infra dependencies —
they're the cheapest way to catch perf regressions in CI.

### 2. API wire-size + latency check

For one-off measurements during development. No tooling needed beyond
`curl`:

```bash
SESSION='authjs.session-token=…'
CL=<cluster-uuid>

# /jobs API: should be small + fast
echo '=== /api/jobs (3 warm runs) ==='
for i in 1 2 3; do
  curl -s -o /dev/null -b "$SESSION" \
    -w "  size=%{size_download}B  total=%{time_total}s\n" \
    "http://localhost:3000/api/clusters/$CL/jobs"
done
# Expected on a cluster with a few hundred jobs: size ≤ 100 KB,
# total ≤ 100 ms warm. Pre-speedup numbers were tens of MB / >1 s.

# Server-rendered page: HTML should already contain table rows
curl -s -b "$SESSION" "http://localhost:3000/clusters/$CL/jobs" \
  | grep -c '<tr'
# >1 = server-rendered first paint working.

# Role-cache effectiveness: tail web logs + fire 5 parallel API calls
docker compose -f docker-compose.dev.yml logs web --tail 0 -f &
LOGTAIL=$!
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -b "$SESSION" "http://localhost:3000/api/clusters/$CL/jobs" &
done; wait
sleep 1; kill $LOGTAIL
# Eyeball the captured logs: `prisma:query SELECT … FROM "User"` should
# appear 0–1 times across all five requests, not 5 times.
```

### 3. Synthetic-load test (run before releasing perf changes)

The unit canaries don't catch DB-side regressions (missing indexes,
slow Prisma queries). For that, seed a cluster with N jobs and time the
listing:

```bash
# Replace <cluster-id> and <user-id> with real values from your dev DB.
docker exec scicom-aura-postgres-1 psql -U aura -d aura -c "
  INSERT INTO \"Job\" (id, \"clusterId\", \"userId\", script, partition, status, \"updatedAt\")
  SELECT
    gen_random_uuid()::text,
    '<cluster-id>',
    '<user-id>',
    '#!/bin/bash' || E'\n' || '#SBATCH --job-name=load-' || g || E'\n' || 'echo hi',
    'gpu',
    'COMPLETED',
    NOW() - (g || ' seconds')::interval
  FROM generate_series(1, 1000) g;
"

# Time the listing.
SESSION='authjs.session-token=…'
time curl -s -b "$SESSION" -o /dev/null \
  "http://localhost:3000/api/clusters/<cluster-id>/jobs"

# Cleanup.
docker exec scicom-aura-postgres-1 psql -U aura -d aura -c "
  DELETE FROM \"Job\" WHERE script LIKE '#%--job-name=load-%';
"
```

Expected on the post-speedup code: ≤ 100 ms warm with 1000 jobs.
Pre-speedup (no composite index, full payload) was multiple seconds at
the same scale.

## Adding tests

Match the existing pattern:

- `*.unit.test.mjs` for pure-logic. Top-level `await import("../lib/foo.ts")` so
  `tsx` resolves the TypeScript on the fly.
- New file gets added to the `Run everything` block above.
- If it pins a perf contract, mark it as a "perf canary" in the
  per-file rundown so future readers know not to relax the assertion
  without reasoning about the speed regression that produced it.
- For unit tests, **do not** pull in real Prisma / NextAuth / React.
  Refactor the logic out into a `lib/` module that's testable in
  isolation; the route handler / hook becomes the glue. The three
  perf canaries above are the canonical example.
