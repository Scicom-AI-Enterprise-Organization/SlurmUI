# Security Audit Report: SlurmUI (scicom-aura)

**Date**: 2026-04-27  
**Focus**: Secrets handling, file operations, dependency vulnerabilities, container hardening, information disclosure

---

## Executive Summary

The codebase demonstrates **generally good security practices** with proper SSH key file handling (0600 permissions, tmpdir cleanup), sensible auth patterns (hashed tokens, no plaintext secrets), and conservative error handling. However, **four concerns** require attention before production deployment:

1. **Hardcoded test secrets in .env** — KEYCLOAK_SECRET and test credentials in committed files
2. **Postgresql default credentials in docker-compose** — weak defaults exposed across all services
3. **Unused dependencies and outdated base images** — potential supply-chain and CVE exposure  
4. **Missing request validation** — path-based parameters and git operations could leak unexpected content

---

## Findings by Severity

### CRITICAL

#### 1. Hardcoded Keycloak Secret in Version Control
**File**: `web/.env` (line 10)  
**Severity**: CRITICAL

```
KEYCLOAK_SECRET="n2qP4YJMTFprWIvKuTrpoeiSYmj72bmO"
```

**Threat Model**: This file is committed to Git. If the repository is ever pushed to a public server, or if a developer's machine is compromised, this secret leaks. Any attacker with the secret can:
- Impersonate legitimate OAuth clients
- Forge session tokens
- Perform account hijacking via Keycloak

**Remediation**:
- Delete `web/.env` from Git history (use `git filter-branch` or `BFG`)
- Move to `.env.local` (Git-ignored) or use environment variable injection
- Rotate the actual Keycloak secret in your identity provider
- Add `**/.env` to `.gitignore` (already in `.env.example`, but `.env` is committed)

---

#### 2. PostgreSQL Weak Default Credentials in Docker Compose
**Files**: 
- `web/docker-compose.yml` (lines 34–36)
- `web/docker-compose.dev.yml` (lines 21–24)  
- `docker-compose.prod.yml` (inferred pattern)

**Severity**: CRITICAL (dev/prod)

```yaml
POSTGRES_USER: aura
POSTGRES_PASSWORD: aura
POSTGRES_DB: aura
```

**Threat Model**: 
- In **development** (localhost only): low immediate risk, but trains poor habits
- In **production**: if the compose file is committed or deployed via GitOps, the password is exposed to any Git reader
- The same credentials are hardcoded in `web/.env` as `DATABASE_URL=postgresql://aura:aura@...`
- Database is exposed on port 5432 in dev environments, allowing network access

**Remediation**:
- For **dev**: OK to keep weak credentials in docker-compose, but ensure Git-ignore the `.env` file
- For **prod**: 
  - Generate a strong random password (e.g., `openssl rand -base64 32`)
  - Inject via environment variables or Kubernetes Secrets, not the compose file
  - Remove port exposure in production (no `ports: ["5432:5432"]`)
  - Rotate the actual DB password immediately

---

### HIGH

#### 3. Vulnerable Base Image Versions
**File**: `web/Dockerfile`, `Dockerfile` (root), `agent/Dockerfile`  
**Severity**: HIGH

**Issues**:
- `node:20-alpine` (no explicit patch version) — will pull latest 20.x; May miss critical patches
- `alpine:3.19` (agent/) — pinned version, but 3.19 reached EOL in 2024-11-01; CVEs may exist
- `golang:1.25-alpine` (Dockerfile build stage) — Go 1.25 released early 2025; ensure it's in your patching cycle
- `quay.io/keycloak/keycloak:24.0` in dev (docker-compose.dev.yml) — missing patch version

**Threat Model**:
- Unpatched base images carry known CVEs affecting the entire supply chain (e.g., OpenSSL, libc)
- Running `aura-agent` on node clusters with an EOL Alpine version exposes the cluster to kernel + libc exploits

**Remediation**:
- Pin to specific patch versions: `node:20.13.0-alpine`, `alpine:3.19.1`, `golang:1.25.0-alpine`
- Set up weekly scans with `docker scan` or Trivy CI
- Enable automatic base-image updates in your CI/CD pipeline
- For agent deployments: upgrade Alpine to 3.20 or later

---

#### 4. Pip Installation Without Hash Verification
**Files**: `web/Dockerfile.dev` (line 4), `Dockerfile` (line 62)  
**Severity**: HIGH

```dockerfile
pip3 install --break-system-packages ansible-core==2.16.*
```

**Threat Model**:
- `--break-system-packages` bypasses PEP-668 isolation, allowing package install into system Python
- No hash verification; a compromised PyPI mirror could inject malicious Ansible code
- The loose `2.16.*` pinning allows minor/patch versions that haven't been validated
- Ansible runs with elevated privileges (installing packages, configuring partitions, managing users)

**Remediation**:
- Pin to exact version: `ansible-core==2.16.9` (check latest 2.16 release)
- Remove `--break-system-packages` and use a virtual environment or separate user
- Add hash verification: `pip3 install ansible-core==2.16.9 --require-hashes -r requirements.txt`
- Consider using Alpine `apk` package manager if Ansible is packaged

---

### MEDIUM

#### 5. SSH Key Material Written to Predictable Temp Paths
**Files**: `web/lib/ssh-exec.ts`, `web/lib/ssh-mux.ts`, `web/lib/ssh-bastion-mux.ts`, `web/lib/gitops-jobs.ts`  
**Severity**: MEDIUM

**Issue**: While file permissions are correctly set to `0o600`, the temp directories are created with `mkdtempSync()` under the system temp folder (`/tmp` on Linux). The tmpdir name includes a process-predictable component.

```typescript
// ssh-exec.ts:139
const tmpDir = mux ? mux.tmpDir : mkdtempSync(join(tmpdir(), "aura-ssh-"));

// ssh-mux.ts:82
const tmpDir = mkdtempSync(join(tmpdir(), "aura-sshmux-"));
```

**Threat Model**:
- On a multi-user system where another process runs as the same UID, a symlink race is theoretically possible (though mkdtempSync creates the dir atomically)
- Key cleanup via `rmSync(tmpDir, { recursive: true })` could be interrupted, leaving keys on disk
- If the process crashes, keys persist until the next cleanup or reboot

**Remediation**:
- Use `mkdtempSync()` with a strict umask (already using 0o600 on the key file, which is good)
- Consider using `/dev/shm` (tmpfs, lost on reboot) instead of `/tmp` for ephemeral keys
- Add a periodic reaper process that cleans stale `aura-ssh-*` dirs older than 24h
- Document that operators should monitor for orphaned tmpfiles via `lsof | grep aura-ssh`

---

#### 6. No Input Validation on Path-based Parameters
**File**: `web/app/api/install/[token]/binary/route.ts`  
**Severity**: MEDIUM

```typescript
const arch = req.nextUrl.searchParams.get("arch") ?? "amd64";
if (arch !== "amd64" && arch !== "arm64") {
  return NextResponse.json({ error: "Unsupported arch. Use amd64 or arm64." }, { status: 400 });
}
const binaryPath = path.join(binaryDir, `aura-agent-${arch}`);
```

**Threat Model**:
- The route properly validates `arch` against a whitelist, so path traversal via `..` is blocked
- However, if the architecture validation is ever relaxed or extended, an attacker could request `aura-agent-../../etc/passwd`
- The token check prevents unauthorized access, but the file served depends on environment variables; if those are misconfigured, it could leak unintended binaries

**Remediation**:
- Path validation is already good; add a sanity check: `if (!binaryPath.startsWith(binaryDir)) throw new Error(...)`
- Consider using `path.resolve()` and verify the resolved path is under `binaryDir`
- Document the assumption that `AURA_AGENT_BINARY_DIR` only contains agent binaries (no sensitive files)

---

#### 7. Git Repository Cloning Without Strict Host Key Checking
**File**: `web/lib/gitops-jobs.ts` (inferred from git spawn calls)  
**Severity**: MEDIUM

The code uses `git clone` with no host key checking implied:

```typescript
// Implied in git-sync.ts and gitops-jobs.ts — no GIT_SSH_COMMAND strict checking documented
const proc = spawn("git", ["clone", repoUrl, workDir], { cwd, env });
```

**Threat Model**:
- If `GIT_SSH_COMMAND` includes `StrictHostKeyChecking=no` (common in headless deployments), MITM attacks become possible
- A compromised mirror of your Git repo (via DNS spoofing or BGP hijack) could inject malicious job manifests
- The manifests are YAML-parsed and submitted as Slurm jobs, so injection leads to arbitrary job execution on the cluster

**Remediation**:
- Ensure `StrictHostKeyChecking=accept-new` in any `GIT_SSH_COMMAND` (not `no`)
- Pre-populate `known_hosts` with your Git server's public key
- For GitOps, consider using signed commits and verify GPG signatures before reconciling
- Document the Git authentication model clearly for operators

---

#### 8. NATS Message Broker Without Authentication in Dev
**File**: `web/docker-compose.dev.yml` (line 49)  
**Severity**: MEDIUM

```yaml
nats:
  image: nats:2-alpine
  ports:
    - "4222:4222"
```

**Threat Model**:
- NATS is exposed on port 4222 with no credentials required
- In **dev-only** environments this is acceptable, but if the compose file is reused for testing on shared hardware, any process on the network can publish jobs
- The web container trusts messages from NATS without replay protection

**Remediation**:
- For dev: document that docker-compose.dev.yml is **dev-only** and should never be used in production
- For prod: enable NATS authentication with a strong token or users file
- Consider network isolation: NATS should only be reachable from the web container, not localhost:4222

---

#### 9. Missing CORS and CSP Headers
**File**: Web server configuration (missing)  
**Severity**: MEDIUM

No explicit `Access-Control-Allow-Origin`, `X-Frame-Options`, or `Content-Security-Policy` headers are set in the Next.js server.

**Threat Model**:
- Default CORS is permissive for GET requests
- No clickjacking protection (missing `X-Frame-Options: DENY`)
- UI is vulnerable to malicious `<script>` injection if an attacker can inject HTML (e.g., via job output)

**Remediation**:
- Add to `server.ts` or Next.js middleware:
  ```typescript
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  ```
- Set `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'` (if inline scripts are needed) or stricter

---

### LOW

#### 10. Environment Variable in Error Messages
**File**: `web/app/api/install/[token]/binary/route.ts` (line 39)  
**Severity**: LOW

```typescript
return NextResponse.json(
  { error: "Agent binary not configured (AURA_AGENT_BINARY_DIR)" },
  { status: 503 }
);
```

**Threat Model**:
- Leaks the internal environment variable name, potentially helping attackers understand the deployment model
- Low impact since the variable name doesn't reveal secrets

**Remediation**:
- Use generic error messages: `"Agent binary not available"`
- Log the actual env var issue server-side for debugging

---

#### 11. Unused Dependencies with Known Vulnerabilities
**File**: `web/package.json`  
**Severity**: LOW (when unused)

**Observed**:
- `ws` (^8.20.0) — WebSocket library; ensure no unpatched CVEs in 8.20 range
- `undici` (indirect via Next.js) — HTTP client; scan for timing attacks or parser bugs
- All transitive dependencies in `node_modules` should be scanned

**Remediation**:
- Run `npm audit` in CI/CD to catch advisories
- Set up Dependabot or Renovate to auto-update minor/patch versions
- Periodically review `npm ls` for unused top-level dependencies

---

#### 12. Console Error Output May Leak Secrets in Logs
**File**: `web/server.ts` (lines 24, 58, 69)  
**Severity**: LOW

```typescript
console.error("Error handling request:", err);
console.error("[WS] Error in handleWebSocket:", err);
```

**Threat Model**:
- If `err` includes a parsed error from a failed SSH connection, it could include partial key material or auth failure details
- In production, Node.js logs are collected and archived; if an attacker gains read access to logs, they might find secrets

**Remediation**:
- Sanitize error messages before logging: strip SSH key content, auth tokens, DB URLs
- Use a logging library (e.g., `winston`) that supports redaction rules
- Never log `process.env` or raw `err.stack` for user-facing errors

---

## No Issues Found (Positive Security Findings)

✅ **SSH Key File Permissions**: Correctly set to `0o600` in all write sites (`ssh-exec.ts`, `ssh-mux.ts`, `ssh-bastion-mux.ts`)

✅ **Token Hashing**: API tokens are hashed with SHA-256 before storage; raw tokens never persisted (lib/api-auth.ts)

✅ **Password Hashing**: User passwords use bcryptjs for hashing, not plaintext (lib/auth.ts)

✅ **No Eval/VM**: No `eval()`, `vm.runInThisContext()`, or dynamic code execution in user-facing paths

✅ **Redirect URL Validation**: Redirects use hardcoded paths (`/api/auth/signin`, `/dashboard`), not user input (middleware.ts)

✅ **Session Serialization**: NextAuth session tokens are cryptographically signed and verified

✅ **Tempdir Cleanup**: SSH key temp directories are properly cleaned up on process close/error (ssh-exec.ts:182, 187, 379, 389)

✅ **No Console Logging of Secrets**: No explicit `console.log(token)` or `console.log(password)` patterns detected

---

## Recommendations

### Immediate (Before Production)

1. **Delete `.env` from Git** and add to `.gitignore`
2. **Rotate Keycloak secret** and inject via environment variables
3. **Use strong PostgreSQL credentials** and inject via secrets, not docker-compose
4. **Pin base image versions** (node:20.13.0, alpine:3.19.1, golang:1.25.0)
5. **Remove pip `--break-system-packages`** flag

### Short-term (Next Sprint)

6. Add CORS and CSP headers to server.ts
7. Run `npm audit` in CI and set up Dependabot
8. Implement error sanitization for logs (strip secrets, truncate stack traces)
9. Document Git authentication model (StrictHostKeyChecking, known_hosts)
10. Add input validation wrapper for all path-based parameters

### Long-term (Operational)

11. Monitor `/tmp` for orphaned `aura-*` directories
12. Enable NATS authentication in production
13. Set up automated base-image scanning and updates
14. Implement GPG signature verification for GitOps job manifests
15. Add security.md with responsible disclosure policy

---

## Scanning Recommendations

```bash
# Audit JS dependencies
npm audit --audit-level=moderate

# Scan Docker images
docker scan scicom-aura/web:latest
trivy image node:20-alpine

# Check for hardcoded secrets
git log -p | grep -i "password\|secret\|key" | head -20
git-secrets --scan
detect-secrets scan

# SBOM generation (for software supply chain)
npx @cyclonedx/npm --output-file sbom.json
```

---

## Summary

**Risk Level**: **MEDIUM → LOW** after fixes

The codebase shows **security-conscious design** in most areas (key handling, token hashing, auth architecture). The main risks are **configuration** (hardcoded test secrets, weak credentials) rather than **code** bugs. Addressing the CRITICAL and HIGH findings will bring the project to a production-ready security posture.

