#!/usr/bin/env bash
# Regression-test orchestrator: spin a small multipass cluster, emit the
# resulting connection details to a JSON env file, then hand off to the
# vitest E2E suite which drives the cluster bootstrap end-to-end via the
# Aura HTTP API.
#
# Why split into two steps?
#   - Spinning multipass is a heavy shell task (snap, sudo, ssh-keygen,
#     iptables) that fits awkwardly into a JS test runner.
#   - Driving the API is dozens of curl-with-jq steps that read way more
#     naturally as Vitest `it()` blocks with proper assertions.
#
# Env vars (with defaults):
#   AURA_BASE         http://localhost:3000   — running Aura web base URL
#   AURA_TOKEN        (required)              — Bearer aura_* admin token
#   MASTER_MEM        4G                      — keep small for CI speed
#   MASTER_DISK       20G
#   WORKER1_NAME      aura-regress-worker-1
#   WORKER1_MEM       2G
#   WORKER1_DISK      10G
#   SKIP_CLEANUP      0                       — set 1 to leave VMs running
#   ENV_OUT           /tmp/aura-regression-env.json
#
# The script is re-runnable: existing VMs with the same names are reused
# (same idempotence guarantee as spin-multipass-cluster.sh).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

log() { printf '\033[1;36m[regress]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[regress]\033[0m %s\n' "$*" >&2; exit 1; }

AURA_BASE="${AURA_BASE:-http://localhost:3000}"
AURA_TOKEN="${AURA_TOKEN:?AURA_TOKEN env var is required (Bearer aura_* admin token)}"
ENV_OUT="${ENV_OUT:-/tmp/aura-regression-env.json}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

# Smaller-than-default VM sizes — we don't need 8 GB on the master for a
# regression test that runs a pandas job and a metrics stack.
export MASTER="${MASTER:-aura-regress-master}"
export WORKER1="${WORKER1:-aura-regress-worker-1}"
export WORKER2="${WORKER2:-aura-regress-worker-2}"
export JUMP="${JUMP:-aura-regress-jump}"
export MASTER_CPUS="${MASTER_CPUS:-2}"
export MASTER_MEM="${MASTER_MEM:-4G}"
export MASTER_DISK="${MASTER_DISK:-20G}"
export WORKER_CPUS="${WORKER_CPUS:-2}"
export WORKER_MEM="${WORKER_MEM:-2G}"
export WORKER_DISK="${WORKER_DISK:-10G}"
export JUMP_CPUS="${JUMP_CPUS:-1}"
export JUMP_MEM="${JUMP_MEM:-512M}"
export JUMP_DISK="${JUMP_DISK:-5G}"
# We don't need the bastion port-forward / cloudflared bits for an
# in-process regression test (everything runs on the host).
export JUMP_FORWARD=0
export JUMP_TUNNEL_CLOUDFLARED=0
export KEY_OUT="${KEY_OUT:-/tmp/aura-regress-id_rsa}"

# Sanity-check tooling early so we fail loud instead of mid-test.
command -v multipass    >/dev/null || die "multipass not on PATH (try: /snap/bin/multipass — sudo snap install multipass)"
command -v jq           >/dev/null || die "jq not on PATH (apt install jq)"
command -v curl         >/dev/null || die "curl not on PATH"

curl -fsS -H "Authorization: Bearer $AURA_TOKEN" "$AURA_BASE/api/clusters" >/dev/null \
  || die "Aura at $AURA_BASE rejected the token ($AURA_TOKEN). Check the server is running and the token is valid."

# WORKER1/WORKER2 + JUMP names get re-exported into the inner script via
# its own env reads (WORKERS array is built from $WORKER1 / $WORKER2).
log "Phase 1: spin multipass VMs (re-use existing ones if any)"
"$HERE/spin-multipass-cluster.sh" >&2

# Resolve the VM IPs the same way the inner script does (CSV) so the env
# JSON has stable absolute IPs the test can paste into the API.
get_ip() { multipass info "$1" --format csv 2>/dev/null | awk -F, 'NR==2 {print $3}'; }

MASTER_IP="$(get_ip "$MASTER")"
WORKER1_IP="$(get_ip "$WORKER1")"
WORKER2_IP="$(get_ip "$WORKER2")"
JUMP_IP="$(get_ip "$JUMP")"
[ -n "$MASTER_IP" ]  || die "could not resolve master IP"
[ -n "$WORKER1_IP" ] || die "could not resolve worker1 IP"
[ -n "$WORKER2_IP" ] || die "could not resolve worker2 IP"
[ -s "$KEY_OUT" ]    || die "expected the master SSH key at $KEY_OUT (spin script should have written it)"

log "Writing env snapshot → $ENV_OUT"
jq -n \
  --arg base       "$AURA_BASE" \
  --arg token      "$AURA_TOKEN" \
  --arg master     "$MASTER" \
  --arg masterIp   "$MASTER_IP" \
  --arg worker1    "$WORKER1" \
  --arg worker1Ip  "$WORKER1_IP" \
  --arg worker2    "$WORKER2" \
  --arg worker2Ip  "$WORKER2_IP" \
  --arg jump       "$JUMP" \
  --arg jumpIp     "$JUMP_IP" \
  --arg keyPath    "$KEY_OUT" \
  --arg sshUser    "ubuntu" \
  --arg testName   "aura-regress-$(date +%Y%m%d-%H%M%S)" \
  '{
    base: $base, token: $token,
    master:  { name: $master,  ip: $masterIp,  sshUser: $sshUser },
    workers: [
      { name: $worker1, ip: $worker1Ip, sshUser: $sshUser },
      { name: $worker2, ip: $worker2Ip, sshUser: $sshUser }
    ],
    jump:    { name: $jump,    ip: $jumpIp,    sshUser: $sshUser },
    keyPath: $keyPath,
    clusterName: $testName
  }' > "$ENV_OUT"
log "Env JSON written. Contents:"
jq . "$ENV_OUT"

log "Phase 2: run vitest E2E suite"
# Vitest reads the env JSON via process.env.AURA_REGRESSION_ENV.
cd "$REPO_ROOT/web"
set +e
AURA_REGRESSION_ENV="$ENV_OUT" npm run -s test:e2e:multipass
suite_rc=$?
set -e

if [ "$SKIP_CLEANUP" = "1" ]; then
  log "SKIP_CLEANUP=1 — leaving VMs running"
else
  log "Phase 3: cleanup multipass VMs"
  multipass delete --purge "$MASTER" "$WORKER1" "$WORKER2" "$JUMP" 2>&1 | sed 's/^/  /' || true
  rm -f "$ENV_OUT" "$KEY_OUT" 2>/dev/null || true
fi

if [ "$suite_rc" -ne 0 ]; then
  die "Vitest E2E suite failed with rc=$suite_rc"
fi
log "Regression test PASSED"
