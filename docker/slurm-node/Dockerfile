# Pre-baked Slurm single-node image for SlurmUI "RunPod Instant Cluster" pods.
#
# FROM runpod/pytorch so CUDA + PyTorch are already present; we layer Slurm,
# munge, mariadb and chrony on top with FIXED uids/gids (slurm=5001,
# munge=5002). A pod launched from this image self-configures Slurm on boot
# (see entrypoint.sh) — no apt "bootstrap" step, and no UID-realignment dance.
#
# Build (amd64 — RunPod GPU hosts are amd64):
#   docker build -t <registry>/scicom/slurm-node:<tag> docker/slurm-node
FROM runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404

ENV DEBIAN_FRONTEND=noninteractive
# Marker so SlurmUI provisioning / ops can recognise an instant-capable image.
ENV AURA_SLURM_NODE_IMAGE=1

# Pin the slurm + munge accounts to FIXED ids BEFORE installing the packages,
# so dpkg's postinst reuses them instead of allocating distro defaults. This is
# the baked equivalent of the pre-create step in nodes/add/route.ts and removes
# the whole "Security violation, Unexpected uid" class of failures (all nodes
# from this image share the same ids). Idempotent: the runpod/pytorch base may
# already ship a `munge` group/user, so remap (groupmod/usermod) when present
# instead of failing on a blind groupadd.
RUN set -eux; \
    if getent group  munge >/dev/null; then groupmod -g 5002 munge; else groupadd -g 5002 munge; fi; \
    if getent passwd munge >/dev/null; then usermod  -u 5002 -g 5002 munge; else useradd -u 5002 -g 5002 -s /usr/sbin/nologin -d /nonexistent -M munge; fi; \
    if getent group  slurm >/dev/null; then groupmod -g 5001 slurm; else groupadd -g 5001 slurm; fi; \
    if getent passwd slurm >/dev/null; then usermod  -u 5001 -g 5001 slurm; else useradd -u 5001 -g 5001 -s /usr/sbin/nologin -d /var/lib/slurm -M slurm; fi

# Everything buildBootstrapScript installs at runtime, baked at build time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server \
      munge libmunge-dev \
      slurm-wlm slurm-client \
      mariadb-server libmariadb-dev \
      chrony \
      nfs-common \
      python3 python3-pip \
      build-essential \
      tini curl ca-certificates iproute2 \
 && rm -rf /var/lib/apt/lists/*

# Slurm runtime dirs (the entrypoint renders slurm.conf at boot from real hw).
RUN mkdir -p /etc/slurm /var/spool/slurmctld /var/spool/slurmd /var/log/slurm /var/lib/slurm /run/munge /var/run/sshd \
 && chown -R slurm:slurm /var/spool/slurmctld /var/spool/slurmd /var/log/slurm /var/lib/slurm \
 && chown -R munge:munge /run/munge

COPY entrypoint.sh /usr/local/bin/slurm-node-entrypoint.sh
RUN chmod +x /usr/local/bin/slurm-node-entrypoint.sh

EXPOSE 22
# tini reaps zombies and forwards signals (no systemd inside the pod).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/slurm-node-entrypoint.sh"]
