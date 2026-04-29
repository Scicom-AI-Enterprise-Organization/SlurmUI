# Live probe — localhost:3001 (unauthenticated)

Hands-on probe of the running dev instance. Findings stand independent of the static-analysis reports.

---

## HIGH

### L1. `/api/metrics` is unauthenticated by default

- **Probe**: `curl http://localhost:3001/api/metrics` returns ~20 KB of Prometheus-format data with cluster IDs, names, node counts, GPU/CPU/memory totals, job counts by status, queue state, etc. — no auth required.
- **Code**: `web/app/api/metrics/route.ts:15` — comment says "Optional auth via METRICS_TOKEN env var. If unset, endpoint is public." `process.env.METRICS_TOKEN` is **not** set in `docker-compose.dev.yml` (only commented out as a placeholder).
- **Threat**: Anyone with network access to the Aura host (LAN, public IP if exposed, sidecar in same k8s namespace) can enumerate the entire fleet topology and live job counts. Not a session-key leak, but a meaningful recon surface.
- **Remediation**: 
  - Set `METRICS_TOKEN` in both compose files and the k8s manifest to a stable random secret.
  - Or move the route under `/api/admin/metrics` so the existing role gate covers it.
  - The current default-public posture for a metrics endpoint shipped with sensitive cluster data is risky.

### L2. No security headers on any response

- **Probe**: `curl -I http://localhost:3001/login` (and other HTML routes) returns no `Content-Security-Policy`, no `X-Frame-Options`, no `X-Content-Type-Options`, no `Referrer-Policy`, no `Permissions-Policy`, no `Strict-Transport-Security`.
- **Threat**:
  - **Clickjacking** — Aura admin pages can be iframed by a malicious origin and tricked-clicked through (CSRF that NextAuth's SameSite=Lax cookie still allows).
  - **MIME confusion** — uploaded job output rendered with sniffed content-type.
  - **MITM downgrade** — no HSTS, so a first-time visit to `http://aura.aies.scicom.dev` can be SSL-stripped.
- **Remediation**: Add a global headers middleware or `next.config.mjs` headers block setting:
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains` (prod only)
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Content-Security-Policy:` at minimum with sensible `default-src 'self'` + the inline-script allowances Next.js needs.

---

## MEDIUM

### L3. `X-Powered-By: Next.js` framework disclosure

- **Probe**: `/login` response header reveals the framework + indirectly the Next.js version (via static-asset URLs `/_next/static/...`).
- **Threat**: Trivial reconnaissance — narrows the attacker's CVE search.
- **Remediation**: `next.config.mjs` → `poweredByHeader: false`.

### L4. `/api/auth/providers` discloses configured login methods unauthenticated

- **Probe**: Returns `{credentials, keycloak}` with full callback URLs.
- **Threat**: Standard NextAuth behaviour, mostly informational. An attacker learns the IdP is Keycloak and the callback path, which helps targeted phishing.
- **Remediation**: Acceptable as-is; consider removing if not needed by the login UI.

---

## LOW / Info — verified safe

- **Header smuggling** — `X-Forwarded-User: admin`, `X-Original-URL: /api/health` did NOT bypass middleware. ✓
- **Cluster id path-traversal** — `/api/clusters/..%2F..` returns 401 cleanly, no 500 / stack trace. ✓
- **Open redirect** — `/api/auth/signin?callbackUrl=https://evil.example/` returns 400 Bad Request (NextAuth allowlists callbackURL). ✓
- **Unauth POST mutations** — every state-changing POST I tried (`/api/jobs`, `/api/me/password`, `/api/api-tokens`, `/api/admin/users`, `/api/sync`) returns 401 without a session. ✓
- **CORS** — preflight from `https://evil.example` returns 401 (no permissive `Access-Control-Allow-Origin`). ✓
- **Cookies** — `authjs.session-token` is `HttpOnly; SameSite=Lax`. `Secure` flag is dev-omitted (expected); production should set `NODE_ENV=production` so NextAuth toggles it on automatically.
- **`/api/health`** — returns only `{"status":"ok"}`. ✓

---

## Test artifacts

```
GET /api/metrics                 200  ~20 KB  text/plain  (UNAUTHENTICATED)
GET /api/health                  200  15 B    application/json
GET /api/clusters                401  24 B    application/json
GET /api/me                      401  24 B    application/json
GET /admin/clusters              307  → /login (middleware)
POST /api/jobs                   401  (state mutation gated)
POST /api/me/password            401
POST /api/admin/users            401
OPTIONS /api/jobs (Origin: evil) 401  (no CORS bypass)
GET /api/auth/signin?callbackUrl=https://evil.example/   400 Bad Request  ✓
```
