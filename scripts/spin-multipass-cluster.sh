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
# Host port forwarded to aura-jump:22 so other machines on the LAN can ssh
# into the bastion via <host-lan-ip>:$JUMP_FORWARD_PORT. Requires sudo the
# first time to install the iptables rules. Set JUMP_FORWARD=0 to skip.
JUMP_FORWARD="${JUMP_FORWARD:-1}"
JUMP_FORWARD_PORT="${JUMP_FORWARD_PORT:-2222}"
# When set to 1, spawn a cloudflared quick-tunnel that exposes localhost
# :$JUMP_FORWARD_PORT on a *.trycloudflare.com TCP endpoint — reachable from
# the internet without router port-forwarding. Requires `cloudflared` on PATH.
JUMP_TUNNEL_CLOUDFLARED="${JUMP_TUNNEL_CLOUDFLARED:-0}"
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

# ── Host port-forward: <host-lan-ip>:$JUMP_FORWARD_PORT → aura-jump:22 ──
# Lets another machine on the LAN reach the multipass bastion (multipass
# VMs normally live on a host-only bridge, so their IPs aren't LAN-routable).
setup_jump_forward() {
  [ "$JUMP_FORWARD" = "1" ] || { log "Jump port-forward disabled (JUMP_FORWARD=0)"; return; }
  command -v iptables >/dev/null || { log "iptables not installed — skipping port-forward"; return; }
  command -v sudo     >/dev/null || { log "sudo not installed — skipping port-forward"; return; }

  log "Port-forwarding host:$JUMP_FORWARD_PORT → $JUMP ($JUMP_IP:22) (sudo required)"
  # -C checks if the rule exists; only add when missing so re-runs are idempotent.
  sudo iptables -t nat -C PREROUTING  -p tcp --dport "$JUMP_FORWARD_PORT" -j DNAT --to-destination "$JUMP_IP:22" 2>/dev/null \
    || sudo iptables -t nat -A PREROUTING  -p tcp --dport "$JUMP_FORWARD_PORT" -j DNAT --to-destination "$JUMP_IP:22"
  # OUTPUT chain so connections from the host itself (e.g. this script's ssh
  # tests) also traverse the DNAT. Some setups require this; harmless if not.
  sudo iptables -t nat -C OUTPUT      -p tcp --dport "$JUMP_FORWARD_PORT" -j DNAT --to-destination "$JUMP_IP:22" 2>/dev/null \
    || sudo iptables -t nat -A OUTPUT      -p tcp --dport "$JUMP_FORWARD_PORT" -j DNAT --to-destination "$JUMP_IP:22"
  sudo iptables -t nat -C POSTROUTING -d "$JUMP_IP" -p tcp --dport 22 -j MASQUERADE 2>/dev/null \
    || sudo iptables -t nat -A POSTROUTING -d "$JUMP_IP" -p tcp --dport 22 -j MASQUERADE
  # Accept inbound on 0.0.0.0:$JUMP_FORWARD_PORT on every interface. Without
  # this a host firewall (ufw/iptables default-drop) rejects the SYN before
  # DNAT runs — the port would only work when the host has no firewall.
  sudo iptables -C INPUT -p tcp --dport "$JUMP_FORWARD_PORT" -j ACCEPT 2>/dev/null \
    || sudo iptables -I INPUT 1 -p tcp --dport "$JUMP_FORWARD_PORT" -j ACCEPT
  # Same for forwarded traffic destined for the multipass bridge.
  sudo iptables -C FORWARD -d "$JUMP_IP" -p tcp --dport 22 -j ACCEPT 2>/dev/null \
    || sudo iptables -I FORWARD 1 -d "$JUMP_IP" -p tcp --dport 22 -j ACCEPT
  sudo sysctl -w net.ipv4.ip_forward=1 >/dev/null
  # DNAT on OUTPUT chain is ignored for localhost by default. Without this,
  # `ssh ubuntu@localhost -p $JUMP_FORWARD_PORT` on the host itself fails —
  # only other LAN machines can reach the forward. Kernels silently drop
  # loopback traffic that would be rerouted to a non-loopback address unless
  # route_localnet is set.
  sudo sysctl -w net.ipv4.conf.all.route_localnet=1 >/dev/null

  HOST_LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$HOST_LAN_IP" ] || HOST_LAN_IP="<host-lan-ip>"
  log "  from another machine: ssh -p $JUMP_FORWARD_PORT ubuntu@$HOST_LAN_IP"
}
setup_jump_forward

# ── Cloudflare quick tunnel (optional) ───────────────────────────────────
# Exposes localhost:$JUMP_FORWARD_PORT on a random *.trycloudflare.com TCP
# URL — reachable from the internet without router/firewall changes. Quick
# tunnels don't need a Cloudflare account or domain; the URL lives until
# this cloudflared process exits. Install cloudflared from:
#   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
CF_TUNNEL_URL=""
CF_TUNNEL_LOG=""
CF_TUNNEL_PID=""
setup_cloudflared_tunnel() {
  [ "$JUMP_TUNNEL_CLOUDFLARED" = "1" ] || return
  if ! command -v cloudflared >/dev/null; then
    log "cloudflared not found on PATH — skipping internet tunnel"
    log "  install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    return
  fi

  # Kill any stale cloudflared quick-tunnel pointed at our forward port
  # (leftovers from a previous run of this script). pkill -f matches the
  # full command line — specific enough to leave unrelated cloudflared
  # processes alone.
  local pattern="cloudflared tunnel.*--url.*tcp://localhost:$JUMP_FORWARD_PORT"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    log "Killing existing cloudflared quick-tunnel for :$JUMP_FORWARD_PORT"
    pkill -f "$pattern" 2>/dev/null || true
    sleep 1
  fi

  CF_TUNNEL_LOG="$(mktemp -t aura-cloudflared.XXXXXX.log)"
  log "Starting cloudflared quick-tunnel → localhost:$JUMP_FORWARD_PORT"
  nohup cloudflared tunnel --no-autoupdate --url "tcp://localhost:$JUMP_FORWARD_PORT" \
    > "$CF_TUNNEL_LOG" 2>&1 &
  CF_TUNNEL_PID=$!
  disown "$CF_TUNNEL_PID" 2>/dev/null || true

  # Poll cloudflared's log for the trycloudflare URL (appears within seconds).
  for _ in $(seq 1 40); do
    sleep 0.5
    CF_TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_TUNNEL_LOG" | head -1 || true)"
    [ -n "$CF_TUNNEL_URL" ] && break
  done

  if [ -n "$CF_TUNNEL_URL" ]; then
    log "  tunnel URL: $CF_TUNNEL_URL  (pid $CF_TUNNEL_PID)"
  else
    log "  cloudflared didn't print a URL in 20s — inspect: $CF_TUNNEL_LOG"
  fi
}
setup_cloudflared_tunnel

# ── Save master's private key to ./id_rsa so SlurmUI can pick it up ──────
log "Saving master's private key to $KEY_OUT"
# Tilde inside `bash -lc '…'` expands inside the VM — not on the host.
multipass exec "$MASTER" -- bash -lc 'cat $HOME/.ssh/id_ed25519' > "$KEY_OUT"
chmod 600 "$KEY_OUT"

# ── Summary ──────────────────────────────────────────────────────────────
echo
echo "======== Cluster ready ========"
echo
echo "Master:       $MASTER ($MASTER_IP)"
for i in "${!WORKERS[@]}"; do
  echo "Worker $((i+1)):     ${WORKERS[$i]} (${WORKER_IPS[$i]})"
done
echo "Jumphost:     $JUMP ($JUMP_IP)"
echo "SSH user:     ubuntu"
echo "Private key:  $KEY_OUT"
echo
echo "-- Paste into SlurmUI's New Cluster dialog --"
echo "  host: $MASTER_IP"
echo "  user: ubuntu"
echo "  port: 22"
echo "  key:  contents of $KEY_OUT"
echo
echo "-- For bastion mode, add these fields --"
echo "  bastion host: $JUMP_IP"
echo "  bastion user: ubuntu"
echo "  bastion port: 22"
echo "  bastion key:  same $KEY_OUT"

if [ "$JUMP_FORWARD" = "1" ] && [ -n "${HOST_LAN_IP:-}" ]; then
  echo
  echo "-- Via host port-forward (listens on 0.0.0.0:$JUMP_FORWARD_PORT) --"
  echo "  bastion host: $HOST_LAN_IP (or any IP bound to this host)"
  echo "  bastion port: $JUMP_FORWARD_PORT"
fi

if [ -n "$CF_TUNNEL_URL" ]; then
  CF_HOST="${CF_TUNNEL_URL#https://}"
  echo
  echo "-- From the internet (cloudflared quick tunnel) --"
  echo "tunnel URL: $CF_TUNNEL_URL"
  echo
  echo "One-shot ssh (ProxyCommand spawns cloudflared per-connection):"
  echo
  echo "ssh -i $KEY_OUT \\"
  echo "-o ProxyCommand='cloudflared access tcp --hostname $CF_HOST' \\"
  echo "ubuntu@ssh"
  echo
  echo "(The 'ubuntu@ssh' host part is ignored — ProxyCommand is the real"
  echo "transport. Requires cloudflared on the client too.)"
fi
echo
echo "Test the bastion from your host:"
echo "ssh -i $KEY_OUT -o IdentitiesOnly=yes \\"
echo "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\"
echo "-o 'ProxyCommand=ssh -i $KEY_OUT -o IdentitiesOnly=yes -W %h:%p ubuntu@$JUMP_IP' \\"
echo "ubuntu@$MASTER_IP hostname"
echo
echo "# Using explicit ProxyCommand so -i applies to the jump hop too"
echo "# (ssh -J doesn't propagate -i to the jump hop on OpenSSH < 8.9)."
echo
echo "To tear everything down:"
echo "multipass delete --purge $MASTER ${WORKERS[*]} $JUMP"
if [ "$JUMP_FORWARD" = "1" ]; then
  echo
  echo "To remove the port-forward rules:"
  echo "sudo iptables -t nat -D PREROUTING -p tcp --dport $JUMP_FORWARD_PORT -j DNAT --to-destination $JUMP_IP:22"
  echo "sudo iptables -t nat -D OUTPUT -p tcp --dport $JUMP_FORWARD_PORT -j DNAT --to-destination $JUMP_IP:22"
  echo "sudo iptables -t nat -D POSTROUTING -d $JUMP_IP -p tcp --dport 22 -j MASQUERADE"
  echo "sudo iptables -D INPUT -p tcp --dport $JUMP_FORWARD_PORT -j ACCEPT"
  echo "sudo iptables -D FORWARD -d $JUMP_IP -p tcp --dport 22 -j ACCEPT"
fi
if [ -n "$CF_TUNNEL_PID" ]; then
  echo
  echo "To stop the cloudflared tunnel:"
  echo "kill $CF_TUNNEL_PID"
fi
