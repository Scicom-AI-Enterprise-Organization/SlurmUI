#!/usr/bin/env bash
# RunPod end-to-end regression. Mirrors regression-test-container.sh but
# instead of spinning a local Docker container it RENTS A REAL GPU POD
# from the RunPod account connected under Admin → GPU Providers.
#
#   ⚠ This costs money while it runs (RTX A6000 ≈ $0.33–0.79/hr). The
#   suite deletes the cluster at the end (terminating the pod) even on
#   failure, but if vitest is SIGKILLed mid-run check the RunPod
#   dashboard for a leftover pod named aura-<cluster-name>.
#
# Prereqs (one-time, via the UI or API):
#   - a GPU provider of kind "runpod" with a valid API key
#   - an SSH key (default name "runpod") under Settings → SSH Keys
#
# Env vars (with defaults):
#   AURA_BASE       http://localhost:3000   — running Aura web base URL
#   AURA_TOKEN      (required)              — Bearer aura_* admin token
#   GPU_TYPE_ID     "NVIDIA RTX A6000"      — RunPod GPU type id
#   PROVIDER_NAME   (first runpod provider) — pick provider by name
#   SSH_KEY_NAME    runpod                  — pick SSH key by name
#   ENV_OUT         /tmp/aura-regression-runpod-env.json

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

log() { printf '\033[1;36m[regress]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[regress]\033[0m %s\n' "$*" >&2; exit 1; }

AURA_BASE="${AURA_BASE:-http://localhost:3000}"
AURA_TOKEN="${AURA_TOKEN:?AURA_TOKEN env var is required (Bearer aura_* admin token)}"
GPU_TYPE_ID="${GPU_TYPE_ID:-NVIDIA RTX A6000}"
PROVIDER_NAME="${PROVIDER_NAME:-}"
SSH_KEY_NAME="${SSH_KEY_NAME:-runpod}"
ENV_OUT="${ENV_OUT:-/tmp/aura-regression-runpod-env.json}"

command -v jq   >/dev/null || die "jq not on PATH (apt install jq)"
command -v curl >/dev/null || die "curl not on PATH"

curl -fsS -H "Authorization: Bearer $AURA_TOKEN" "$AURA_BASE/api/clusters" >/dev/null \
  || die "Aura at $AURA_BASE rejected the token. Check the server is running and the token is valid."

# Fail fast on missing prereqs — better here than 3 tests into the suite.
PROVIDERS="$(curl -fsS -H "Authorization: Bearer $AURA_TOKEN" "$AURA_BASE/api/admin/gpu-providers")"
echo "$PROVIDERS" | jq -e '[.[] | select(.kind == "runpod")] | length > 0' >/dev/null \
  || die "No RunPod GPU provider configured. Add one under Admin → GPU Providers."
if [ -n "$PROVIDER_NAME" ]; then
  echo "$PROVIDERS" | jq -e --arg n "$PROVIDER_NAME" '[.[] | select(.name == $n)] | length > 0' >/dev/null \
    || die "No GPU provider named '$PROVIDER_NAME'."
fi
curl -fsS -H "Authorization: Bearer $AURA_TOKEN" "$AURA_BASE/api/admin/ssh-keys" \
  | jq -e --arg n "$SSH_KEY_NAME" '[.[] | select(.name == $n)] | length > 0' >/dev/null \
  || log "warning: no SSH key named '$SSH_KEY_NAME' — the suite will fall back to the first key"

log "Writing env snapshot → $ENV_OUT"
jq -n \
  --arg base       "$AURA_BASE" \
  --arg token      "$AURA_TOKEN" \
  --arg gpuTypeId  "$GPU_TYPE_ID" \
  --arg provider   "$PROVIDER_NAME" \
  --arg sshKeyName "$SSH_KEY_NAME" \
  --arg testName   "aura-regress-runpod-$(date +%Y%m%d-%H%M%S)" \
  '{
    base: $base, token: $token,
    gpuTypeId: $gpuTypeId,
    sshKeyName: $sshKeyName,
    clusterName: $testName
  } + (if $provider == "" then {} else { gpuProviderName: $provider } end)' > "$ENV_OUT"
jq 'del(.token)' "$ENV_OUT"

log "Phase 2: run vitest E2E suite (runpod-cluster) — rents a real pod!"
cd "$REPO_ROOT/web"
set +e
AURA_REGRESSION_ENV="$ENV_OUT" npm run -s test:e2e:runpod
suite_rc=$?
set -e

rm -f "$ENV_OUT" 2>/dev/null || true

if [ "$suite_rc" -ne 0 ]; then
  die "Vitest RunPod E2E suite failed with rc=$suite_rc — check the RunPod dashboard for leftover pods."
fi
log "RunPod regression test PASSED"
