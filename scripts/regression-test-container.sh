#!/usr/bin/env bash
# Container-based end-to-end regression. Mirrors regression-test-multipass.sh
# but uses a single Ubuntu 24.04 Docker container with the default cap set
# (CAP_SYS_ADMIN dropped) so it behaves like a managed-GPU container
# (Alibaba PAI-DSW, vast.ai, runpod, etc.). The bootstrap auto-detects
# the missing systemd and falls through to pm2-go for daemon supervision.
#
# Step-for-step the suite is the multipass one minus the storage steps
# (NFS server self-hosting + mount attach both need CAP_SYS_ADMIN, so
# those endpoints are expected to fail clean here — we assert the
# behaviour separately).
#
# Env vars (with defaults):
#   AURA_BASE     http://localhost:3000   — running Aura web base URL
#   AURA_TOKEN    (required)              — Bearer aura_* admin token
#   SSH_PORT      2225                    — host port forwarded to the container's :22
#   SKIP_CLEANUP  0                       — set 1 to leave the container running
#   ENV_OUT       /tmp/aura-regression-container-env.json

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

log() { printf '\033[1;36m[regress]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[regress]\033[0m %s\n' "$*" >&2; exit 1; }

AURA_BASE="${AURA_BASE:-http://localhost:3000}"
AURA_TOKEN="${AURA_TOKEN:?AURA_TOKEN env var is required (Bearer aura_* admin token)}"
ENV_OUT="${ENV_OUT:-/tmp/aura-regression-container-env.json}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

export NAME="${NAME:-aura-regress-container}"
export SSH_PORT="${SSH_PORT:-2225}"
export IMAGE="${IMAGE:-ubuntu:24.04}"
export KEY_OUT="${KEY_OUT:-/tmp/aura-regress-container-id_rsa}"
export CONTAINER_USER="${CONTAINER_USER:-root}"

command -v docker >/dev/null || die "docker not on PATH"
command -v jq     >/dev/null || die "jq not on PATH (apt install jq)"
command -v curl   >/dev/null || die "curl not on PATH"

curl -fsS -H "Authorization: Bearer $AURA_TOKEN" "$AURA_BASE/api/clusters" >/dev/null \
  || die "Aura at $AURA_BASE rejected the token. Check the server is running and the token is valid."

log "Phase 1: spin Docker container (re-use existing if any)"
"$HERE/spin-docker-container-cluster.sh" >&2
[ -s "$KEY_OUT" ] || die "expected the container SSH key at $KEY_OUT after spin"

CAPS="$(ssh -i "$KEY_OUT" \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o BatchMode=yes -p "$SSH_PORT" "${CONTAINER_USER}@127.0.0.1" \
  'grep ^CapBnd /proc/self/status | awk "{print \$2}"')"

log "Writing env snapshot → $ENV_OUT"
jq -n \
  --arg base       "$AURA_BASE" \
  --arg token      "$AURA_TOKEN" \
  --arg host       "127.0.0.1" \
  --argjson port   "$SSH_PORT" \
  --arg sshUser    "$CONTAINER_USER" \
  --arg keyPath    "$KEY_OUT" \
  --arg containerName "$NAME" \
  --arg caps       "$CAPS" \
  --arg testName   "aura-regress-ctr-$(date +%Y%m%d-%H%M%S)" \
  '{
    base: $base, token: $token,
    controller: { host: $host, port: $port, sshUser: $sshUser },
    keyPath: $keyPath,
    containerName: $containerName,
    capBnd: $caps,
    clusterName: $testName
  }' > "$ENV_OUT"
jq . "$ENV_OUT"

log "Phase 2: run vitest E2E suite (container-cluster)"
cd "$REPO_ROOT/web"
set +e
AURA_REGRESSION_ENV="$ENV_OUT" npm run -s test:e2e:container
suite_rc=$?
set -e

if [ "$SKIP_CLEANUP" = "1" ]; then
  log "SKIP_CLEANUP=1 — leaving container '$NAME' running"
else
  log "Phase 3: docker rm -f $NAME"
  docker rm -f "$NAME" 2>&1 | sed 's/^/  /' || true
  rm -f "$ENV_OUT" "$KEY_OUT" "${KEY_OUT}.pub" 2>/dev/null || true
fi

if [ "$suite_rc" -ne 0 ]; then
  die "Vitest container E2E suite failed with rc=$suite_rc"
fi
log "Container regression test PASSED"
