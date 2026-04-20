#!/usr/bin/env bash
# Provision a small multipass-based Slurm test cluster for SlurmUI.
#
#   1 master (aura-test)   — 2 CPU / 8 GB / 40 GB disk
#   2 workers (aura-worker-1, aura-worker-2) — 2 CPU / 4 GB / 20 GB each
#   1 jumphost (aura-jump) — 1 CPU / 1 GB / 10 GB disk (bastion)
#
# After running:
#   - Master's ed25519 private key is written to ./id_rsa (paste into the
#     New Cluster dialog's "private key" field).
#   - The master can ssh itself and both workers as `ubuntu` (passwordless).
#   - The same key is authorized on the jumphost, so SlurmUI can ssh into
#     aura-jump first and ProxyJump through to the master.
#
# Re-running the script is safe: existing VMs are left alone, keys are
# deduplicated, authorized_keys entries aren't appended twice.
#
# Requires: multipass (snap install multipass), ssh-keygen.

set -euo pipefail

MASTER="${MASTER:-aura-test}"
WORKERS=("${WORKER1:-aura-worker-1}" "${WORKER2:-aura-worker-2}")
JUMP="${JUMP:-aura-jump}"
MASTER_CPUS="${MASTER_CPUS:-2}"
MASTER_MEM="${MASTER_MEM:-8G}"
MASTER_DISK="${MASTER_DISK:-40G}"
WORKER_CPUS="${WORKER_CPUS:-2}"
WORKER_MEM="${WORKER_MEM:-4G}"
WORKER_DISK="${WORKER_DISK:-20G}"
JUMP_CPUS="${JUMP_CPUS:-1}"
JUMP_MEM="${JUMP_MEM:-1G}"
JUMP_DISK="${JUMP_DISK:-10G}"
IMAGE="${IMAGE:-24.04}"
KEY_OUT="${KEY_OUT:-./id_rsa}"

log()  { printf '\033[1;36m[aura]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[aura]\033[0m %s\n' "$*" >&2; exit 1; }

command -v multipass  >/dev/null || die "multipass not found — install with: sudo snap install multipass"
command -v ssh-keygen >/dev/null || die "ssh-keygen not found — install openssh-client"

# ── Launch VMs ────────────────────────────────────────────────────────────
launch_vm() {
  local name="$1" cpus="$2" mem="$3" disk="$4"
  if multipass info "$name" >/dev/null 2>&1; then
    log "VM '$name' already exists — skipping launch"
    return 0
  fi
  log "Launching '$name' ($cpus CPU, $mem RAM, $disk disk)"
  multipass launch "$IMAGE" --name "$name" --cpus "$cpus" --memory "$mem" --disk "$disk"
}

launch_vm "$MASTER" "$MASTER_CPUS" "$MASTER_MEM" "$MASTER_DISK"
for w in "${WORKERS[@]}"; do
  launch_vm "$w" "$WORKER_CPUS" "$WORKER_MEM" "$WORKER_DISK"
done
launch_vm "$JUMP" "$JUMP_CPUS" "$JUMP_MEM" "$JUMP_DISK"

# ── Resolve IPs ───────────────────────────────────────────────────────────
get_ip() {
  multipass info "$1" --format csv 2>/dev/null | awk -F, 'NR==2 {print $3}'
}

MASTER_IP="$(get_ip "$MASTER")"
[ -n "$MASTER_IP" ] || die "could not resolve IP for $MASTER"
log "Master:  $MASTER → $MASTER_IP"

declare -a WORKER_IPS=()
for w in "${WORKERS[@]}"; do
  ip="$(get_ip "$w")"
  [ -n "$ip" ] || die "could not resolve IP for $w"
  WORKER_IPS+=("$ip")
  log "Worker:  $w → $ip"
done

JUMP_IP="$(get_ip "$JUMP")"
[ -n "$JUMP_IP" ] || die "could not resolve IP for $JUMP"
log "Jump:    $JUMP → $JUMP_IP"

# ── Generate an ed25519 key on the master (if it doesn't have one) ───────
log "Ensuring master has an ed25519 key at ~/.ssh/id_ed25519"
multipass exec "$MASTER" -- bash -c '
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  if [ ! -f ~/.ssh/id_ed25519 ]; then
    ssh-keygen -t ed25519 -N "" -C "$(hostname)@aura-master" -f ~/.ssh/id_ed25519 >/dev/null
  fi
' >/dev/null

# Read through `bash -c` so the tilde expands inside the VM, not on the host.
MASTER_PUB="$(multipass exec "$MASTER" -- bash -lc 'cat $HOME/.ssh/id_ed25519.pub' | tr -d '\r' | sed '/^$/d' | head -1)"
[ -n "$MASTER_PUB" ] || die "failed to read master's public key"

# ── Authorize master on master + workers so it can ssh everywhere ────────
authorize_on() {
  local target="$1"
  multipass exec "$target" -- bash -c "
    mkdir -p ~/.ssh && chmod 700 ~/.ssh
    touch ~/.ssh/authorized_keys
    grep -qxF '$MASTER_PUB' ~/.ssh/authorized_keys || echo '$MASTER_PUB' >> ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
  "
}

log "Authorizing master's key on master + all workers + jumphost"
authorize_on "$MASTER"
for w in "${WORKERS[@]}"; do authorize_on "$w"; done
# Jumphost uses the same key so a single credential covers bastion login
# and the final hop to master (ssh -J ubuntu@jump ubuntu@master).
authorize_on "$JUMP"

# ── Verify ssh reachability from master ──────────────────────────────────
ssh_check() {
  local ip="$1"
  multipass exec "$MASTER" -- ssh \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o BatchMode=yes \
    -o ConnectTimeout=5 \
    "ubuntu@$ip" 'hostname' 2>/dev/null
}

log "Verifying ssh from master to every host"
if out="$(ssh_check "$MASTER_IP")"; then
  log "  master → master ($MASTER_IP) [$out] OK"
else
  die "master cannot ssh itself at $MASTER_IP"
fi
for i in "${!WORKERS[@]}"; do
  w="${WORKERS[$i]}" ip="${WORKER_IPS[$i]}"
  if out="$(ssh_check "$ip")"; then
    log "  master → $w ($ip) [$out] OK"
  else
    die "master cannot ssh $w at $ip"
  fi
done

# Direct ssh from master to jumphost (sanity check on the bastion login itself).
if out="$(ssh_check "$JUMP_IP")"; then
  log "  master → $JUMP ($JUMP_IP) [$out] OK"
else
  die "master cannot ssh $JUMP at $JUMP_IP"
fi

# End-to-end bastion hop: ssh into master via the jumphost. Mirrors the
# path SlurmUI will take when "Bastion host" is configured.
#
# ProxyJump needs StrictHostKeyChecking/UserKnownHostsFile applied to BOTH
# the outer and inner ssh. The cleanest way is to pass them via a nested
# ProxyCommand so the options propagate verbatim to the first hop. Otherwise
# the inner hop's host-key prompt trips with BatchMode=yes.
log "Verifying ProxyJump (master via $JUMP)"
if out="$(multipass exec "$MASTER" -- ssh \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o BatchMode=yes -o ConnectTimeout=10 \
    -o "ProxyCommand=ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -W %h:%p ubuntu@$JUMP_IP" \
    "ubuntu@$MASTER_IP" 'hostname' 2>&1)"; then
  log "  master via $JUMP → master [$out] OK"
else
  log "  ProxyJump output: $out"
  die "ProxyJump via $JUMP to $MASTER_IP failed"
fi

# ── Save master's private key to ./id_rsa so SlurmUI can pick it up ──────
log "Saving master's private key to $KEY_OUT"
# Tilde inside `bash -lc '…'` expands inside the VM — not on the host.
multipass exec "$MASTER" -- bash -lc 'cat $HOME/.ssh/id_ed25519' > "$KEY_OUT"
chmod 600 "$KEY_OUT"

# ── Summary ──────────────────────────────────────────────────────────────
echo
echo "╭─────────────────────────────────────────────────────────────────╮"
echo "│ Cluster ready.                                                  │"
echo "├─────────────────────────────────────────────────────────────────┤"
printf "│ %-15s %-20s\n" "Master:" "$MASTER ($MASTER_IP)"
for i in "${!WORKERS[@]}"; do
  printf "│ %-15s %-20s\n" "Worker $((i+1)):" "${WORKERS[$i]} (${WORKER_IPS[$i]})"
done
printf "│ %-15s %-20s\n" "Jumphost:" "$JUMP ($JUMP_IP)"
printf "│ %-15s %s\n" "SSH user:" "ubuntu"
printf "│ %-15s %s\n" "Private key:" "$KEY_OUT"
echo "├─────────────────────────────────────────────────────────────────┤"
echo "│ Paste into SlurmUI's New Cluster dialog:                        │"
printf "│   host:    %-52s │\n" "$MASTER_IP"
printf "│   user:    %-52s │\n" "ubuntu"
printf "│   port:    %-52s │\n" "22"
printf "│   key:     %-52s │\n" "contents of $KEY_OUT"
echo "├─────────────────────────────────────────────────────────────────┤"
echo "│ For bastion mode, add these fields:                             │"
printf "│   bastion host:    %-44s │\n" "$JUMP_IP"
printf "│   bastion user:    %-44s │\n" "ubuntu"
printf "│   bastion port:    %-44s │\n" "22"
printf "│   bastion key:     %-44s │\n" "same $KEY_OUT"
echo "╰─────────────────────────────────────────────────────────────────╯"
echo
echo "Test the bastion from your host:"
echo "  ssh -i $KEY_OUT -o IdentitiesOnly=yes \\"
echo "    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\"
echo "    -o 'ProxyCommand=ssh -i $KEY_OUT -o IdentitiesOnly=yes -W %h:%p ubuntu@$JUMP_IP' \\"
echo "    ubuntu@$MASTER_IP hostname"
echo
echo "  # Using explicit ProxyCommand so -i applies to the jump hop too"
echo "  # (ssh -J doesn't propagate -i to the jump hop on OpenSSH < 8.9)."
echo
echo "To tear everything down:"
echo "  multipass delete --purge $MASTER ${WORKERS[*]} $JUMP"
