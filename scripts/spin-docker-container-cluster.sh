#!/usr/bin/env bash
# Spin a Docker container that mimics a managed-GPU container cluster
# (Alibaba PAI-DSW, vast.ai, runpod, etc.):
#   - Ubuntu 24.04, no systemd, sshd as PID 1.
#   - Default Docker capability set (drops CAP_SYS_ADMIN among others — so
#     mount() syscalls return EPERM, exactly like the real environment).
#   - SSH on a host port (default 127.0.0.1:2225) with key-based root login.
#
# After this exits successfully:
#   - The key is at ./id_rsa_container (or $KEY_OUT).
#   - The container is reachable via `ssh -i $KEY_OUT -p $SSH_PORT root@127.0.0.1`.
#
# Re-running reuses the existing container (same idempotence guarantee as
# spin-multipass-cluster.sh).
#
# Requires: docker, ssh-keygen.

set -euo pipefail

NAME="${NAME:-aura-regress-container}"
SSH_PORT="${SSH_PORT:-2225}"
IMAGE="${IMAGE:-ubuntu:24.04}"
KEY_OUT="${KEY_OUT:-./id_rsa_container}"
CONTAINER_USER="${CONTAINER_USER:-root}"

log() { printf '\033[1;36m[aura]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[aura]\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker     >/dev/null || die "docker not on PATH"
command -v ssh-keygen >/dev/null || die "ssh-keygen not on PATH (apt install openssh-client)"

# ── Generate a host key the test can hand to Aura ────────────────────────
if [ ! -s "$KEY_OUT" ]; then
  log "Generating ed25519 key at $KEY_OUT"
  ssh-keygen -t ed25519 -N "" -C "aura-regress-container@$(hostname)" -f "$KEY_OUT" >/dev/null
fi
chmod 600 "$KEY_OUT"
PUBKEY="$(cat "${KEY_OUT}.pub")"

# ── Stop a stale container (re-run) ──────────────────────────────────────
if docker ps -a --format '{{.Names}}' | grep -qxF "$NAME"; then
  if docker ps --format '{{.Names}}' | grep -qxF "$NAME"; then
    log "Container '$NAME' is already running — verifying SSH"
  else
    log "Container '$NAME' exists but stopped — removing"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
fi

# ── Boot the container ───────────────────────────────────────────────────
if ! docker ps --format '{{.Names}}' | grep -qxF "$NAME"; then
  log "Launching '$NAME' on $IMAGE (sshd as PID 1, no systemd, default caps)"
  # Inline boot script writes the test key into authorized_keys and execs
  # sshd in foreground. We deliberately do NOT add --cap-add / --privileged
  # so the container mimics a managed-GPU sandbox (CAP_SYS_ADMIN dropped →
  # any mount() syscall returns EPERM, exactly like the real environment).
  # The /sbin/init we'd need for systemd isn't here either — the bootstrap's
  # supervisor detector falls through to pm2-go.
  # IMPORTANT: bind sshd inside the container to the SAME port the host
  # forward uses (default 2225). That way SSH from the web server
  # (host:2225 → container:2225) AND from the container to itself
  # (loopback 127.0.0.1:2225 — what the metrics-fan-out / NFS-server
  # scripts do internally) both succeed against one endpoint. Mapping
  # host:2225 → container:22 instead breaks every "controller SSHes
  # itself" code path: the loopback connect hits port 2225 which
  # isn't bound, and exporters / Prom + Grafana never get installed.
  PRIVKEY="$(cat "$KEY_OUT")"
  docker run -d \
    --name "$NAME" \
    --restart unless-stopped \
    -p "127.0.0.1:${SSH_PORT}:${SSH_PORT}" \
    -e PUBKEY="$PUBKEY" \
    -e PRIVKEY="$PRIVKEY" \
    -e SSH_PORT="$SSH_PORT" \
    "$IMAGE" \
    bash -c '
      set -e
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
        openssh-server sudo ca-certificates iproute2 procps curl python3 >/dev/null
      mkdir -p /var/run/sshd /root/.ssh
      chmod 700 /root/.ssh
      echo "$PUBKEY"  > /root/.ssh/authorized_keys
      chmod 600 /root/.ssh/authorized_keys
      # Drop the SAME key inside the container as /root/.ssh/id_ed25519
      # so the fan-out scripts (metrics/install, storage/nfs-server, etc.)
      # can SSH from the controller to itself with the implicit key search.
      # The multipass spin script does the same — the master holds its own
      # private key. Without this, every "controller SSHes the controller"
      # path fails with "Permission denied (publickey)" because root has
      # no key in its homedir.
      echo "$PRIVKEY" > /root/.ssh/id_ed25519
      chmod 600 /root/.ssh/id_ed25519
      # PermitRootLogin yes + key-only (no password). Pin sshd to
      # ${SSH_PORT} so loopback connects from inside the container reach
      # the same endpoint the host port-forward exposes.
      sed -i "s/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/" /etc/ssh/sshd_config
      sed -i "s/^#*PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config
      sed -i "s/^#*Port.*/Port ${SSH_PORT}/" /etc/ssh/sshd_config
      grep -q "^Port " /etc/ssh/sshd_config || echo "Port ${SSH_PORT}" >> /etc/ssh/sshd_config
      ssh-keygen -A
      exec /usr/sbin/sshd -D -e
    ' >/dev/null
fi

# ── Wait for sshd to come up ─────────────────────────────────────────────
log "Waiting for sshd on 127.0.0.1:${SSH_PORT}..."
for i in $(seq 1 60); do
  if ssh -i "$KEY_OUT" \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes -o ConnectTimeout=2 \
        -p "$SSH_PORT" "${CONTAINER_USER}@127.0.0.1" 'hostname' >/dev/null 2>&1; then
    log "sshd ready (took ${i}s)"
    break
  fi
  sleep 1
  if [ "$i" = 60 ]; then
    docker logs --tail 40 "$NAME" >&2 || true
    die "sshd never came up on 127.0.0.1:${SSH_PORT}"
  fi
done

# ── Verify cap set matches the real GPU container we test against ────────
CAPS="$(ssh -i "$KEY_OUT" \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o BatchMode=yes -p "$SSH_PORT" "${CONTAINER_USER}@127.0.0.1" \
  'grep ^CapBnd /proc/self/status | awk "{print \$2}"' 2>/dev/null)"
log "Container CapBnd: $CAPS (managed-GPU containers typically report 00000000a80425fb)"

cat <<EOF

======== Container ready ========

Host:        127.0.0.1
Port:        $SSH_PORT
User:        $CONTAINER_USER
Private key: $KEY_OUT
Container:   $NAME ($IMAGE)
CapBnd:      $CAPS

To ssh:
  ssh -i $KEY_OUT -p $SSH_PORT $CONTAINER_USER@127.0.0.1

To tear down:
  docker rm -f $NAME
EOF
