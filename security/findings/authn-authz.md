# Authentication, Authorization, Session & CSRF — audit findings

Comprehensive review of `middleware.ts`, `lib/auth.ts`, `lib/api-auth.ts`, and 25+ route handlers.

---

## CRITICAL

### 1. Implicit `NEXTAUTH_SECRET` configuration

- **File / line**: `lib/auth.ts:28-82`
- **Issue**: NextAuth v5 config doesn't explicitly pass `secret: process.env.NEXTAUTH_SECRET`. NextAuth auto-derives if env is set, but in production with ephemeral pods or multiple replicas, an unstable / unset secret means JWTs become unverifiable across restarts and every user is force-logged-out (this matches the `JWTSessionError: no matching decryption secret` we already saw in dev compose).
- **Threat**: Session invalidation storm; possible security regression if a dev / fallback random secret is used in prod.
- **Remediation**: Pass `secret` explicitly, fail-fast at boot if unset in `NODE_ENV=production`. Already partially mitigated by aligning the dev/prod compose values.

### 2. Middleware operator-precedence ambiguity

- **File / line**: `middleware.ts:8-10`
- **Issue**: `nextUrl.pathname.startsWith("/admin") || nextUrl.pathname.startsWith("/api/clusters") && req.method !== "GET"` parses as `startsWith("/admin") || (startsWith("/api/clusters") && method !== "GET")`. The intent reads cleanly to a human as "admin OR (cluster mutation)", but it would be very easy for a future edit to invert the precedence. The current behaviour blocks non-GET on `/api/clusters/*` from VIEWERs, which is correct.
- **Threat**: Latent bug — one parenthesis change away from VIEWERs being able to POST/DELETE clusters.
- **Remediation**: Add explicit parens and a short comment about intent.

---

## HIGH

### 3. `/api/install/[token]` token replay

- **File / line**: `app/api/install/[token]/route.ts:13-14`, `app/api/install/[token]/binary/route.ts:17`
- **Issue**: Both endpoints check `installToken` + `installTokenExpiresAt` but neither sets `installTokenUsedAt` after first download. A leaked token can be replayed (script + binary fetched again, or substituted maliciously) until expiry.
- **Threat**: Anyone who intercepts the install URL can re-bootstrap a node or pull the agent binary.
- **Remediation**: On first hit (script OR binary) atomically set `installTokenUsedAt = now()` and reject on subsequent reuse. Audit-log the claim.

### 4. RBAC overly restrictive on Prometheus / Grafana proxies

- **File / line**: `app/api/clusters/[id]/prometheus/[...path]/route.ts:35-48`, `app/grafana-proxy/[id]/[[...path]]/route.ts:38-51`
- **Issue**: Both proxies require admin OR active `ClusterUser`. A VIEWER who submitted a Job to the cluster but isn't on the ClusterUser list can't see metrics for their own job. Inverse of a security bug — over-restrictive; not exploitable.
- **Remediation**: Optionally allow `Job.userId === session.user.id` as a third path. Low priority.

### 5. Per-route ownership pattern inconsistency

- **File / line**: `app/api/clusters/[id]/jobs/[jobId]/route.ts:25, 97, 202`
- **Issue**: GET and DELETE filter by `userId` in the Prisma WHERE; PATCH fetches the row first then validates ownership in app code. Today both work; a future PATCH edit that drops the explicit check would silently allow cross-user edits.
- **Remediation**: Standardise — always include the ownership predicate in the query.

---

## MEDIUM

### 6. Bearer token comparison not constant-time at app layer

- **File / line**: `lib/api-auth.ts:55-75`
- **Issue**: `findUnique({ where: { tokenHash } })` performs equality in the DB. The hash is SHA-256 (good), but no `crypto.timingSafeEqual()` guard at the app layer. Defense-in-depth only — DB equality + network jitter make this hard to exploit, and tokens are 24-byte base64url (high entropy).
- **Remediation**: After the DB lookup, optionally verify with `timingSafeEqual`.

### 7. Cookie flags depend on env, not explicit config

- **File / line**: `lib/auth.ts:28-82`
- **Issue**: NextAuth's defaults set `httpOnly: true, sameSite: "lax", secure: NODE_ENV === "production"`. We don't override; mostly fine. Worth being explicit so a misconfigured `NODE_ENV` doesn't downgrade to non-secure.
- **Remediation**: Explicit `cookies` block in NextAuth config + assert HTTPS on prod boot.

### 8. PATCH job leaks browser cookies to internal fetch

- **File / line**: `app/api/clusters/[id]/jobs/[jobId]/route.ts:236-244`
- **Issue**: After saving `metricsPort`, the route does a fire-and-forget `fetch(/metrics/refresh-targets)` and forwards the original cookie header. Internal-only call but the pattern leaks session cookies into a server-to-server request that could be logged or routed unexpectedly.
- **Remediation**: Make `refresh-targets` callable by an internal service token, or invoke the refresh logic in-process rather than re-entering HTTP.

### 9. Password-reset endpoint discloses token validity via response shape

- **File / line**: `app/api/password-reset/by-token/[token]/route.ts:11-22`
- **Issue**: Valid token returns user metadata; invalid returns 404. Token is unguessable, but the differential reveals whether a *known* token is valid.
- **Remediation**: Return a uniform shape regardless of validity (or a generic error).

---

## LOW / INFO

### 10. Keycloak role revocation lag

- **File / line**: `lib/auth.ts:93-124`
- **Issue**: Role re-read from local DB on each JWT refresh. If admin is revoked at Keycloak, the local DB row may still say ADMIN until manually synced.
- **Remediation**: Refresh from IdP claims periodically or on every callback.

### 11. Audit logging gaps on read paths

- **File / line**: many GETs
- **Issue**: Mutations are audit-logged consistently; sensitive reads (job stdout `?output=1`, Prometheus queries, Grafana proxy traffic) are not.
- **Remediation**: Decide compliance posture — log if needed.

### 12. Bearer tokens vulnerable on misconfigured HTTP clients

- **File / line**: `lib/api-auth.ts`
- **Issue**: Token taken from `Authorization` header. If a user PATs over plain HTTP, token leaks.
- **Remediation**: Document HTTPS-only, set HSTS header.

---

## Acceptable risk / well-mitigated

- CSRF — handled by NextAuth's built-in csrf-token cookie + same-origin pattern; our APIs use `auth()` which validates the cookie not just origin.
- Header bypass (`X-Forwarded-For`, `X-Original-URL`) — middleware reads from NextAuth's normalised session, not raw headers.
- SQL injection — Prisma everywhere; no raw queries on user input that I could find.
- Open redirect — no app-level redirects built from user input.

## Summary

2 critical, 3 high, 4 medium, 3 info. The most actionable items are: fail-fast on missing `NEXTAUTH_SECRET` in prod (#1), enforce single-use on install tokens (#3), and tighten the middleware's gate intent with explicit parens (#2).
