# scripts/

Helper scripts for local development and end-to-end testing.

| Script | What it does |
|---|---|
| [`spin-multipass-cluster.sh`](./spin-multipass-cluster.sh) | Stands up a throwaway Slurm test cluster on [Multipass](https://multipass.run/): 1 master, 2 workers, 1 jumphost/bastion. Generates an SSH key, wires passwordless access between all nodes, and optionally exposes the bastion via a LAN port-forward or a Cloudflare quick-tunnel. |
| [`regression-test-multipass.sh`](./regression-test-multipass.sh) | End-to-end regression runner. Wraps the spin script to launch VMs, then hands off to the Vitest suite at `web/tests/e2e/multipass-cluster.test.ts` which drives the full bootstrap → operate → verify flow against a running SlurmUI via the public HTTP API. |
| [`spin-docker-container-cluster.sh`](./spin-docker-container-cluster.sh) | Spins a single Ubuntu 24.04 Docker container with sshd as PID 1, no systemd, and the default Docker capability set (CAP_SYS_ADMIN dropped). Mimics a managed-GPU container (Alibaba PAI-DSW, vast.ai, runpod, etc.). |
| [`regression-test-container.sh`](./regression-test-container.sh) | End-to-end regression for the container-cluster shape. Wraps the docker-container spin script and drives `web/tests/e2e/container-cluster.test.ts` — exercises the pm2-go supervisor path and asserts the storage endpoints fail cleanly given the missing CAP_SYS_ADMIN. |

## Which regression test should I run?

Both suites exercise the same public HTTP API and the same bootstrap
playbook — they only differ in what shape of cluster they target:

| | Multipass | Container |
|---|---|---|
| Cluster shape | 1 master + 2 workers + 1 jumphost VMs (Ubuntu 24.04) | 1 Ubuntu 24.04 Docker container |
| Supervisor | systemd | pm2-go |
| Capabilities | full (root in VM) | default Docker set; CAP_SYS_ADMIN dropped |
| Tests storage attach? | yes — NFS server + mount on every worker | no — asserts the endpoint refuses with an actionable error |
| Tests multi-node? | yes — adds 2 workers via the API | no — single node by construction |
| Suite step count | 18 | 13 |
| Warm wall time | ~2-3 min | ~2-3 min |
| Cold wall time | ~15 min (image pull dominates) | ~5-7 min |

In CI you'd run both. Locally, pick the one that matches your deploy:
running on managed-GPU containers (PAI-DSW / vast / runpod) → container
suite. Running on real VMs or bare metal → multipass suite. The
container suite was also used to validate the public real-prod cluster
at `8.222.165.68:1024` (8× H20-3e) end-to-end — bootstrap → vllm
install → pytorch job → Prom + Grafana → teardown all clean.

## `spin-multipass-cluster.sh`

Useful when you don't have a real cluster handy and want to exercise
bootstrap, add-node, and job submission against something that looks like
a real multi-node deployment (including bastion / ProxyJump paths).

### Requirements

- `multipass` — `sudo snap install multipass`
- `ssh-keygen` — from `openssh-client`
- (optional) `cloudflared` on `$PATH` if you set `JUMP_TUNNEL_CLOUDFLARED=1`

### Run

```bash
./scripts/spin-multipass-cluster.sh
```

Creates:

| VM | Role | Resources |
|---|---|---|
| `aura-test` | Slurm master | 2 CPU / 8 GB / 40 GB |
| `aura-worker-1` | worker | 2 CPU / 4 GB / 20 GB |
| `aura-worker-2` | worker | 2 CPU / 4 GB / 20 GB |
| `aura-jump` | bastion | 1 CPU / 1 GB / 10 GB |

On success it writes the master's private key to `./id_rsa`. Paste that
into SlurmUI's **New Cluster → Private key** field (use the bastion's
address as the controller host with `bastion=on`, or point directly at
`aura-test`'s IP with `bastion=off`).

### Useful env overrides

| Var | Default | Purpose |
|---|---|---|
| `MASTER` / `WORKER1` / `WORKER2` / `JUMP` | `aura-test` / `aura-worker-1` / `aura-worker-2` / `aura-jump` | VM names |
| `MASTER_CPUS` / `MASTER_MEM` / `MASTER_DISK` | `2` / `8G` / `40G` | Master sizing |
| `WORKER_CPUS` / `WORKER_MEM` / `WORKER_DISK` | `2` / `4G` / `20G` | Worker sizing |
| `IMAGE` | `24.04` | Ubuntu image passed to `multipass launch` |
| `KEY_OUT` | `./id_rsa` | Path for the generated master key |
| `JUMP_FORWARD` | `1` | Install iptables rules on the host forwarding `:$JUMP_FORWARD_PORT` → `aura-jump:22` (requires sudo on first run). Set to `0` to skip. |
| `JUMP_FORWARD_PORT` | `2222` | Host port used by the LAN forward |
| `JUMP_TUNNEL_CLOUDFLARED` | `0` | When `1`, launch a `cloudflared` quick-tunnel exposing the bastion over `*.trycloudflare.com` for internet access without router config |

Re-running is safe — existing VMs are left alone, keys are deduplicated,
and `authorized_keys` entries are not appended twice.

### Tear down

```bash
multipass delete --purge aura-test aura-worker-1 aura-worker-2 aura-jump
```

## `regression-test-multipass.sh`

Full end-to-end regression. Orchestrates two phases:

1. **Phase 1** — wraps [`spin-multipass-cluster.sh`](./spin-multipass-cluster.sh)
   to launch a fresh 1-master + 2-worker + 1-jump cluster (smaller defaults
   than the bare spin script — see the env table below), then writes a
   connection-detail snapshot to `/tmp/aura-regression-env.json`.
2. **Phase 2** — runs `npm run test:e2e:multipass` inside `web/`, which
   executes [`web/tests/e2e/multipass-cluster.test.ts`](../web/tests/e2e/multipass-cluster.test.ts).
   Every step is an ordered `it()` block driving the public Aura HTTP API
   with the supplied admin token; the suite is the closest thing to a
   customer install we can re-run on demand.

### What the suite verifies (18 ordered steps)

1. upload the multipass-generated SSH key → `POST /api/admin/ssh-keys`
2. create the cluster row → `POST /api/clusters`
3. bootstrap (Slurm, slurmd, munge, mariadb) → `POST /api/v1/clusters/:id/bootstrap`
4. confirm the default `main` partition was auto-seeded
5. add worker 1 → `POST /api/v1/clusters/:id/nodes`
6. add worker 2
7. resolve the master hostname from `slurm_hosts_entries` (catches a bootstrap that skipped `seedControllerAsNode`)
8. register an NFS-server entry in cluster config
9. provision the self-hosted NFS server → `POST /api/v1/clusters/:id/storage/nfs-servers`
10. register an NFS mount entry referencing the server
11. attach the mount on master + every worker → `POST /api/v1/clusters/:id/storage/mounts`
12. provision the Bearer-token owner as a Linux user → `POST /api/v1/clusters/:id/users`
13. install pandas (per-node, `/opt/aura-venv`) → `POST /api/v1/clusters/:id/python-packages`
14. submit a tiny pandas job + poll to `COMPLETED` → `POST /api/v1/clusters/:id/jobs`
15. install node_exporter + GPU exporter on every node → `POST /api/v1/clusters/:id/metrics/install`
16. deploy Prometheus + Grafana → `POST /api/v1/clusters/:id/metrics/stack`
17. probe Prometheus `:9090/-/ready` and Grafana `:3000/api/health` from inside the cluster (poll up to 60 s for the first scrape)
18. tear down → `POST /api/clusters/:id/teardown` (plus `afterAll` calls `DELETE /api/clusters/:id` so the cluster row never lingers)

### Requirements

- Everything `spin-multipass-cluster.sh` needs (`multipass`, `ssh-keygen`).
- `jq`, `curl`.
- A SlurmUI instance running at `$AURA_BASE` with an admin Bearer token
  (`/profile/api-tokens`).

### Run

```bash
export AURA_BASE=http://localhost:3000
export AURA_TOKEN=aura_...

./scripts/regression-test-multipass.sh
```

The wrapper:

1. **Phase 1** logs `[regress] Phase 1: spin multipass VMs (re-use existing ones if any)` and skips any VM that already exists.
2. **Phase 2** logs `[regress] Phase 2: run vitest E2E suite` and runs the Vitest pass.
3. **Phase 3 — `multipass delete --purge`** every VM the spin script created
   (master, both workers, jumphost). The Vitest suite's `afterAll` also
   calls `POST /api/clusters/:id/teardown` + `DELETE /api/clusters/:id`,
   so on a successful default run neither the VMs nor the cluster DB row
   are left behind. Set `SKIP_CLEANUP=1` to skip the purge when you want
   to inspect VM state after the suite exits.

Total wall time is roughly **2–3 min** when the VMs are already warm,
**15 min** from a cold launch (the multipass image pull dominates).

### Env overrides

The wrapper re-exports its own defaults into `spin-multipass-cluster.sh`,
so anything that script understands works here too. The differences are:

| Var | Default | Purpose |
|---|---|---|
| `AURA_BASE` | `http://localhost:3000` | URL of the SlurmUI under test |
| `AURA_TOKEN` | *(required)* | Admin Bearer token. Pre-flight curl fails fast if it isn't accepted. |
| `ENV_OUT` | `/tmp/aura-regression-env.json` | Where to write the connection snapshot Vitest reads via `AURA_REGRESSION_ENV` |
| `SKIP_CLEANUP` | `0` | When `1`, leave VMs running after the suite finishes (good for iterating against the same state) |
| `MASTER` / `WORKER1` / `WORKER2` / `JUMP` | `aura-regress-*` | VM names (separate namespace from the bare spin script so the two can coexist) |
| `MASTER_MEM` / `WORKER_MEM` / `JUMP_MEM` | `4G` / `2G` / `512M` | Smaller than the bare spin script's defaults — regression doesn't need 8 GB on the master |
| `JUMP_FORWARD` / `JUMP_TUNNEL_CLOUDFLARED` | `0` / `0` | Always disabled — the regression test runs against the host directly, no LAN/tunnel exposure required |
| `KEY_OUT` | `/tmp/aura-regress-id_rsa` | Path the master's private key is written to (Vitest reads it back to attach to the new cluster) |

### Iterating

If the suite fails mid-run, the wrapper exits non-zero and (by default)
deletes the VMs. To debug:

```bash
SKIP_CLEANUP=1 ./scripts/regression-test-multipass.sh
# inspect the cluster via the standard Aura UI or:
PATH=/snap/bin:$PATH multipass exec aura-regress-master -- sudo journalctl -u slurmctld
# fix code, then re-run — the spin script is idempotent so VM launch is a no-op
SKIP_CLEANUP=1 ./scripts/regression-test-multipass.sh
```

Direct Vitest invocation (skips Phase 1 entirely — only works once the
env JSON exists):

```bash
cd web
AURA_REGRESSION_ENV=/tmp/aura-regression-env.json npm run test:e2e:multipass
```

### Tear down

`SKIP_CLEANUP=1` runs leave VMs behind. Clean them up with:

```bash
PATH=/snap/bin:$PATH multipass delete --purge \
  aura-regress-master aura-regress-worker-1 \
  aura-regress-worker-2 aura-regress-jump
```

## `spin-docker-container-cluster.sh`

Spins a single Ubuntu 24.04 Docker container with sshd as PID 1, no
systemd, and the default Docker capability set (CAP_SYS_ADMIN dropped).
Mimics a managed-GPU container — the same `CapBnd 00000000a80425fb` the
real GPU containers report. Used by
[`regression-test-container.sh`](./regression-test-container.sh) to drive
an E2E pass over the pm2-go supervisor branch without needing access to
a real managed-GPU host.

### Requirements

- `docker` — on most Ubuntu hosts: `sudo apt install -y docker.io` (and add
  your user to the `docker` group, or run with `sudo`).
- `ssh-keygen` from `openssh-client`.

### Run

```bash
./scripts/spin-docker-container-cluster.sh
```

On success the container is reachable at `127.0.0.1:2225` as `root`
using the generated `./id_rsa_container` key. Re-running is idempotent
— an existing container with the same name is reused if running.

### Env overrides

| Var | Default | Purpose |
|---|---|---|
| `NAME` | `aura-regress-container` | Docker container name |
| `SSH_PORT` | `2225` | Host port forwarded to the container's :22 |
| `IMAGE` | `ubuntu:24.04` | Base image (any glibc-Linux with apt should work) |
| `KEY_OUT` | `./id_rsa_container` | Generated SSH key path |
| `CONTAINER_USER` | `root` | SSH user (only root makes sense for managed-GPU mimicry) |

### Tear down

```bash
docker rm -f aura-regress-container
```

## `regression-test-container.sh`

End-to-end regression for a **container-shaped** cluster. Mirrors
`regression-test-multipass.sh` but uses one Docker container instead of
four VMs, and verifies the pm2-go branch of the bootstrap +
storage-endpoint failure-mode handling that managed-GPU containers
exercise.

### What the suite verifies (13 ordered steps)

1. container's CapBnd has CAP_SYS_ADMIN dropped (sanity-check the mimic)
2. upload the generated SSH key → `POST /api/admin/ssh-keys`
3. create the cluster row → `POST /api/clusters` (single-node)
4. bootstrap — controller-detects no systemd, installs pm2-go, supervises slurmctld / slurmd / munge / mariadb under pm2 → `POST /api/v1/clusters/:id/bootstrap`
5. confirm `main` partition + the controller landed in `slurm_hosts_entries`
6. NFS-server provisioning surfaces the overlayfs / cap-set error with an actionable hint (NOT a silent 500)
7. provision the Bearer-token owner as a Linux user
8. install pandas (per-node, `/opt/aura-venv`)
9. submit + poll a pandas job to `COMPLETED`
10. install node_exporter + GPU exporter under pm2 → `POST /api/v1/clusters/:id/metrics/install` (asserts the `[supervisor] using: pm2` banner is present in logs)
11. deploy Prometheus + Grafana under pm2 → `POST /api/v1/clusters/:id/metrics/stack`
12. Prometheus `:9090/-/ready` + Grafana `:3000/api/health` respond from inside the container (polls up to 60 s for the first scrape)
13. tear down → `POST /api/clusters/:id/teardown` (`afterAll` calls `DELETE` too)

### Requirements

- Everything `spin-docker-container-cluster.sh` needs (docker, ssh-keygen).
- `jq`, `curl`.
- A SlurmUI instance running at `$AURA_BASE` with an admin Bearer token.

### Run

```bash
export AURA_BASE=http://localhost:3000
export AURA_TOKEN=aura_...

./scripts/regression-test-container.sh
```

The wrapper:

1. **Phase 1** spins the Docker container (re-uses an existing one).
2. **Phase 2** runs `npm run test:e2e:container` inside `web/`.
3. **Phase 3 — `docker rm -f`** the container created. Set
   `SKIP_CLEANUP=1` to keep it for debugging.

Total wall time is ~2-3 min warm, ~5-7 min cold (the Ubuntu image pull
plus the apt-install in the boot script dominate).

### Env overrides

The wrapper re-exports its defaults into `spin-docker-container-cluster.sh`,
so anything that script understands works here too. The differences are:

| Var | Default | Purpose |
|---|---|---|
| `AURA_BASE` | `http://localhost:3000` | URL of the SlurmUI under test |
| `AURA_TOKEN` | *(required)* | Admin Bearer token |
| `ENV_OUT` | `/tmp/aura-regression-container-env.json` | Connection snapshot Vitest reads via `AURA_REGRESSION_ENV` |
| `SKIP_CLEANUP` | `0` | When `1`, leave the container running after the suite finishes |
| `NAME` | `aura-regress-container` | Container name |
| `SSH_PORT` | `2225` | Host port for the container's :22 |
| `KEY_OUT` | `/tmp/aura-regress-container-id_rsa` | Path the generated SSH key is written to |

### Direct Vitest invocation

After the spin script has populated the env JSON:

```bash
cd web
AURA_REGRESSION_ENV=/tmp/aura-regression-container-env.json \
  npm run test:e2e:container
```

### Tear down

`SKIP_CLEANUP=1` runs leave the container behind. Clean it up with:

```bash
docker rm -f aura-regress-container
```
