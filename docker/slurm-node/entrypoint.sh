#!/usr/bin/env bash
# SlurmUI instant-cluster node entrypoint.
#
# Brings up a single-node Slurm controller+worker in one container, honours the
# PUBLIC_KEY SSH contract SlurmUI relies on, and bakes the RunPod self-hop NAT
# fix so the box's own controller->node SSH hops loop back to local sshd.
#
# Runs under tini (PID 1). Holds the container open on sshd.
set -u

log() { echo "[slurm-node] $*"; }

###############################################################################
# 1. SSH contract — SlurmUI logs in over SSH with the key it sent as PUBLIC_KEY
###############################################################################
mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ -n "${PUBLIC_KEY:-}" ]; then
  grep -qF "$PUBLIC_KEY" /root/.ssh/authorized_keys 2>/dev/null \
    || echo "$PUBLIC_KEY" >> /root/.ssh/authorized_keys
fi
# Self-hop key: several SlurmUI flows SSH controller -> node; on a single-node
# pod that is the box to itself, so authorise its own key.
[ -f /root/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519 -q
grep -qF "$(cat /root/.ssh/id_ed25519.pub)" /root/.ssh/authorized_keys 2>/dev/null \
  || cat /root/.ssh/id_ed25519.pub >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

###############################################################################
# 2. Self-hop NAT fix (Notion: "The Self-Hop That Couldn't Reach Itself")
#    SlurmUI's controller->node hops dial the pod's PUBLIC RunPod IP:port, which
#    RunPod's edge NAT won't hairpin back to the container. Make sshd ALSO
#    listen on the public port and rewrite the public IP -> 127.0.0.1 in root's
#    ssh config, so an outbound `ssh root@<public-ip> -p <public-port>` from the
#    box lands on its own local sshd.
###############################################################################
PUB_IP="${RUNPOD_PUBLIC_IP:-}"
PUB_PORT="${RUNPOD_TCP_PORT_22:-}"
if [ -n "$PUB_PORT" ] && [ "$PUB_PORT" != "22" ]; then
  if ! grep -qE "^Port ${PUB_PORT}\$" /etc/ssh/sshd_config; then
    printf '\nPort 22\nPort %s\n' "$PUB_PORT" >> /etc/ssh/sshd_config
    log "sshd will also listen on public port ${PUB_PORT}"
  fi
fi
if [ -n "$PUB_IP" ]; then
  cat > /root/.ssh/config <<CFG
Host ${PUB_IP}
    HostName 127.0.0.1
    StrictHostKeyChecking accept-new
CFG
  chmod 600 /root/.ssh/config
  log "ssh-config rewrites ${PUB_IP} -> 127.0.0.1 (self-hop loopback)"
fi

# Host keys + privsep dir, then start sshd early so SlurmUI can connect ASAP.
ssh-keygen -A >/dev/null 2>&1 || true
mkdir -p /var/run/sshd
/usr/sbin/sshd -D -e &
SSH_PID=$!
log "sshd started (pid ${SSH_PID})"

###############################################################################
# 3. Munge — shared auth daemon for Slurm
###############################################################################
if [ ! -s /etc/munge/munge.key ]; then
  /usr/sbin/create-munge-key -f >/dev/null 2>&1 \
    || dd if=/dev/urandom of=/etc/munge/munge.key bs=1 count=1024 >/dev/null 2>&1
  log "generated munge key"
fi
chown munge:munge /etc/munge/munge.key && chmod 400 /etc/munge/munge.key
mkdir -p /run/munge && chown munge:munge /run/munge
runuser -u munge -- /usr/sbin/munged 2>/dev/null \
  || sudo -u munge /usr/sbin/munged 2>/dev/null \
  || /usr/sbin/munged --force 2>/dev/null
log "munged started"

###############################################################################
# 4. Render slurm.conf from this node's real hardware (single node, loopback)
###############################################################################
HOST="$(hostname -s)"
CPUS="$(nproc --all)"
LSCPU="$(lscpu 2>/dev/null)"
SOCKETS="$(echo "$LSCPU" | awk -F: '/^Socket\(s\):/ {gsub(/ /,"",$2); print $2}')"; SOCKETS="${SOCKETS:-1}"
CORES="$(echo "$LSCPU"   | awk -F: '/^Core\(s\) per socket:/ {gsub(/ /,"",$2); print $2}')"; CORES="${CORES:-$CPUS}"
THREADS="$(echo "$LSCPU" | awk -F: '/^Thread\(s\) per core:/ {gsub(/ /,"",$2); print $2}')"; THREADS="${THREADS:-1}"
MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
# Safety margin so slurmd's reported RealMemory >= configured (kernel drift).
MEM_MB=$(( MEM_MB > 1024 ? MEM_MB - 512 : MEM_MB ))
# Enumerate the ACTUAL GPU device files. RunPod (and MIG / partial allocations)
# can hand out NON-CONTIGUOUS minors — e.g. /dev/nvidia0 + /dev/nvidia2 for a
# 2-GPU pod — so never assume /dev/nvidia0..N-1 (slurmd fatally errors on a
# gres.conf File= that doesn't exist). Glob the real device nodes and size the
# gres off them, keeping gres.conf and slurm.conf's Gres=gpu:N in lockstep.
GPU_DEVS="$(ls /dev/nvidia[0-9]* 2>/dev/null)"
GPUS="$(printf '%s\n' "$GPU_DEVS" | grep -c '^/dev/nvidia')"

GRES_TYPES=""
GRES_LINE=""
if [ "${GPUS:-0}" -gt 0 ]; then
  GRES_TYPES="GresTypes=gpu"
  GRES_LINE=" Gres=gpu:${GPUS}"
  printf '%s\n' "$GPU_DEVS" | sed 's#^#Name=gpu File=#' > /etc/slurm/gres.conf
fi

if [ ! -f /etc/slurm/slurm.conf ]; then
  cat > /etc/slurm/slurm.conf <<CONF
ClusterName=aura-cluster
SlurmctldHost=${HOST}
MpiDefault=none
ProctrackType=proctrack/linuxproc
ReturnToService=2
SlurmctldPidFile=/run/slurmctld.pid
SlurmctldPort=6817
SlurmdPidFile=/run/slurmd.pid
SlurmdPort=6818
SlurmdSpoolDir=/var/spool/slurmd
SlurmUser=slurm
StateSaveLocation=/var/spool/slurmctld
SwitchType=switch/none
TaskPlugin=task/none
SchedulerType=sched/backfill
SelectType=select/cons_tres
SlurmctldLogFile=/var/log/slurm/slurmctld.log
SlurmdLogFile=/var/log/slurm/slurmd.log
AccountingStoreFlags=job_script
${GRES_TYPES}
NodeName=${HOST} NodeAddr=127.0.0.1 CPUs=${CPUS} Sockets=${SOCKETS} CoresPerSocket=${CORES} ThreadsPerCore=${THREADS} RealMemory=${MEM_MB}${GRES_LINE} State=UNKNOWN
PartitionName=main Default=YES Nodes=${HOST} MaxTime=INFINITE State=UP
CONF
  log "rendered /etc/slurm/slurm.conf (${CPUS} CPU, ${MEM_MB} MB, ${GPUS} GPU)"
fi
chown slurm:slurm /etc/slurm/slurm.conf

# cgroup.conf — make slurmd's cgroup/v2 plugin work in a plain container that has
# no systemd/dbus. Without IgnoreSystemd=yes, slurmd's cgroup init tries to
# create a systemd scope over dbus, fails ("cannot connect to dbus system
# daemon"), and slurmd never starts — leaving the node UNKNOWN/non-responding.
# We don't need cgroup resource enforcement on a single-node pod (gres still sets
# CUDA_VISIBLE_DEVICES), so all Constrain* are off.
if [ ! -f /etc/slurm/cgroup.conf ]; then
  cat > /etc/slurm/cgroup.conf <<'CGROUP'
CgroupPlugin=autodetect
IgnoreSystemd=yes
ConstrainCores=no
ConstrainRAMSpace=no
ConstrainSwapSpace=no
ConstrainDevices=no
CGROUP
  log "wrote /etc/slurm/cgroup.conf (IgnoreSystemd=yes — no-systemd container)"
fi

###############################################################################
# 5. Start Slurm daemons + chrony (no systemd in a container)
###############################################################################
# slurmd 23.11's cgroup/v2 plugin must create a scope dir under
# /sys/fs/cgroup/system.slice on startup. Containers with a writable cgroup
# (RunPod GPU pods, privileged/CAP_SYS_ADMIN docker) allow this; plain
# unprivileged docker mounts /sys/fs/cgroup read-only and slurmd can't start.
# Best-effort make it writable and pre-create the parent so slurmd's scope
# mkdir succeeds. Harmless where cgroup is already writable.
mount -o remount,rw /sys/fs/cgroup 2>/dev/null || true
mkdir -p /sys/fs/cgroup/system.slice 2>/dev/null || true

chronyd 2>/dev/null || true
slurmctld 2>/dev/null || /usr/sbin/slurmctld 2>/dev/null || true
log "slurmctld started"
# Supervise slurmd: GPU device files can lag container boot, and a transient
# failure must not leave the node DOWN forever — restart it until it stays up.
( while true; do
    slurmd -D >> /var/log/slurm/slurmd.log 2>&1 || /usr/sbin/slurmd -D >> /var/log/slurm/slurmd.log 2>&1
    sleep 3
  done ) &
log "slurmd supervisor started"

# Cold-start ordering can leave the node DOWN; nudge it back to service.
sleep 5
scontrol update NodeName="${HOST}" State=RESUME 2>/dev/null || true

log "ready — node ${HOST} (${CPUS} CPU / ${GPUS} GPU)"

###############################################################################
# 6. Hold the container open on sshd
###############################################################################
wait "${SSH_PID}"
