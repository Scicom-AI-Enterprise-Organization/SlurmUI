# Container Cluster Support — Design Spec

**Status:** Approved  •  **Date:** 2026-05-21  •  **Branch:** `feat/container-clusters`

## 1. Problem

Aura currently provisions Slurm clusters under the assumption that every node is a baremetal host or VM with:
- `systemd` available to manage daemons (slurmctld, slurmd, slurmdbd, munge, aura-agent)
- An NFS export from the controller (`/mgmt`) for distributing `slurm.conf`, `munge.key`, etc.
- Direct apt package installation and persistent storage

This breaks when clients hand us containerized environments — typically RunPod, Lambda Labs, vast.ai, or in-house Kubernetes pods exposed via SSH. In those environments:
- No `systemd` (PID 1 is the entrypoint of the container, not init)
- No kernel NFS server inside the container (kernel modules unavailable without `--privileged`)
- Often a single multi-GPU node (e.g. 8×H20) is all the user has
- Sometimes multiple containers with varying degrees of inter-node reachability

We need to support these environments end-to-end: creation, bootstrap, node addition, config propagation, teardown — without disturbing the existing baremetal path.

## 2. Scope

### In scope
- A new cluster type `CONTAINER` (alongside the existing implicit `BAREMETAL`)
- Single-node container clusters (controller = worker, one container hosts everything)
- Multi-node container clusters where the user explicitly opts in to cross-node scheduling
- A user-facing toggle that maps to a hard Slurm-enforced partition constraint
- New Ansible roles and playbooks that use `supervisord` instead of `systemd`
- Config distribution via SSH `scp` from the Aura backend, replacing NFS for management data
- Optional external NFS client mount for shared user data (no NFS server inside containers)

### Out of scope (deferred)
- Hybrid clusters mixing container and baremetal nodes
- Container lifecycle management (pod eviction, restart re-enrollment)
- Overlay networking (Headscale/Tailscale) — punted; user is responsible for inter-container networking
- GPU device passthrough configuration (assumed handled by the provider)
- Auto-discovery of container hardware (CPU/memory/GPU counts) — user supplies these on cluster create, same as baremetal

## 3. Architecture

### 3.1 Cluster type field

A new enum on the `Cluster` model:

```prisma
enum ClusterType {
  BAREMETAL
  CONTAINER
}

model Cluster {
  // existing fields preserved verbatim
  clusterType              ClusterType  @default(BAREMETAL)
  allowCrossNodeScheduling Boolean      @default(false)
}
```

`clusterType` is set on cluster creation and immutable thereafter — switching a cluster between types post-bootstrap is not supported in v1.

`allowCrossNodeScheduling` is meaningful only when `clusterType=CONTAINER`. For `BAREMETAL`, multi-node scheduling is always allowed (no enforced limit). The field can be flipped on live `CONTAINER` clusters and triggers a config propagate + slurmctld reconfigure.

### 3.2 Bootstrap and config distribution

For container clusters, NFS is dropped entirely from the **management** path (slurm.conf, munge.key, gres.conf, cgroup.conf). The Aura backend already SSHes into every node — it becomes the config hub.

**Controller bootstrap** (SSH → controller container):
1. Install packages: `munge slurm-wm supervisor` via apt
2. Create slurm + munge system users (`common` role, unchanged)
3. Generate `/etc/munge/munge.key` locally
4. Generate `/etc/slurm/slurm.conf` via the same template as baremetal, with two container-specific differences:
   - Partition definitions render with `MaxNodes=1` when `allowCrossNodeScheduling=false`
   - `NodeAddr` uses the controller's reachable hostname/IP supplied by the user (not the NFS-resolved hostname)
5. Drop `/etc/supervisor/conf.d/{munge,slurmctld,slurmdbd,aura-agent}.conf` files
6. Start supervisord (foreground if PID 1, otherwise as background process)

**Worker bootstrap** (SSH → each worker container):
1. Install packages: `munge slurm-wm supervisor`
2. Receive `/etc/munge/munge.key` via `scp` from the Aura backend (which fetched it from the controller during controller bootstrap)
3. Receive `/etc/slurm/slurm.conf` via `scp` from the Aura backend
4. Drop `/etc/supervisor/conf.d/{munge,slurmd}.conf` files
5. Start supervisord

**No NFS server is set up inside a container.** Data NFS (user data) is still supported but only as an **external** client mount — see §3.5.

### 3.3 Process supervision: supervisord

`supervisord` replaces `systemd` for container clusters. Each daemon gets a conf file in `/etc/supervisor/conf.d/`:

```ini
[program:munged]
command=/usr/sbin/munged --foreground
user=munge
autostart=true
autorestart=true
stdout_logfile=/var/log/aura/munge.log
stderr_logfile=/var/log/aura/munge.err
priority=10

[program:slurmctld]
command=/usr/sbin/slurmctld -D
user=slurm
autostart=true
autorestart=true
stdout_logfile=/var/log/aura/slurmctld.log
stderr_logfile=/var/log/aura/slurmctld.err
priority=20
depends_on=munged
```

`supervisord` itself runs either as PID 1 (when the container's entrypoint is replaced by our bootstrap) or as a background daemon started by `supervisord -c /etc/supervisor/supervisord.conf` if PID 1 is already taken by the provider's entrypoint. The role detects which case applies.

`supervisorctl` replaces `systemctl` everywhere in container-mode Ansible tasks and runtime commands (start/stop/reload/restart).

### 3.4 Cross-node scheduling toggle

When `allowCrossNodeScheduling=false`, the `slurm.conf` partition definition renders with `MaxNodes=1`:

```
PartitionName=default Nodes=ALL Default=YES MaxNodes=1 State=UP
```

This is a hard Slurm-side enforcement. `sbatch --nodes=2` returns an error from slurmctld; users cannot bypass it from the job submission side.

When toggled to `true`, the `MaxNodes` directive is omitted and standard multi-node scheduling resumes. Changing the toggle on a live cluster:
1. PATCH `/api/clusters/[id]` updates the DB field
2. Aura regenerates `slurm.conf` with the new partition rendering
3. `propagate_config_container.yml` scp's the new config to all nodes
4. `scontrol reconfigure` issued on controller — running jobs are unaffected, future submissions follow the new constraint

### 3.5 Data storage

The existing `data_nfs_server` / `data_nfs_path` fields in `cluster.config` continue to work for container clusters, with one critical change: **the NFS server is assumed to be external**. Aura never tries to export NFS from a container.

- If `data_nfs_server` is set: the `nfs_client` role (existing, unchanged behavior) mounts it on every container node as a client. This requires `CAP_SYS_ADMIN` on the container — most GPU container providers grant this.
- If `data_nfs_server` is empty: no shared data mount is configured. Single-node clusters operate fine on the container's local filesystem. Multi-node clusters display a UI warning: "No shared data storage configured. Job output will be local to each node."

This decision avoids forcing users into NFS when they don't have an external server, while still supporting the common case where they do.

### 3.6 Aura agent (NATS mode)

The `aura-agent` Go binary has no systemd dependency in its compiled code; only the deployment unit assumes systemd. For container clusters:

- The `.service.j2` template is not used
- A `aura-agent.conf` template targeting `/etc/supervisor/conf.d/` is dropped instead
- Env vars (`NATS_URL`, `CLUSTER_ID`, `ANSIBLE_PLAYBOOK_DIR`, `SLURM_USER`) populate via supervisord's `environment=` directive
- Agent runs on the controller container only (workers don't run an agent; they receive commands via SSH from the controller or Aura)
- Teardown removes the conf file and runs `supervisorctl stop aura-agent && supervisorctl remove aura-agent` instead of `systemctl disable + systemd-run`

## 4. Implementation surface

### 4.1 Database

One Prisma migration: `20260521000000_add_cluster_type_and_cross_node_scheduling`:

```sql
CREATE TYPE "ClusterType" AS ENUM ('BAREMETAL', 'CONTAINER');

ALTER TABLE "Cluster"
  ADD COLUMN "clusterType" "ClusterType" NOT NULL DEFAULT 'BAREMETAL',
  ADD COLUMN "allowCrossNodeScheduling" BOOLEAN NOT NULL DEFAULT false;
```

The default `BAREMETAL` ensures all existing clusters keep their current behavior.

### 4.2 Ansible

**New roles** (no changes to existing roles):
- `ansible/roles/supervisord/` — installs supervisord, ensures `/etc/supervisor/conf.d/`, manages the daemon (PID 1 detection)
- `ansible/roles/munge_container/` — installs munge, key generation (controller) or key receipt (worker), drops `munged.conf` for supervisord, no systemd handler
- `ansible/roles/slurm_controller_container/` — slurmctld + slurmdbd, supervisord confs, slurm.conf template aware of `allow_cross_node_scheduling` group_var
- `ansible/roles/slurm_worker_container/` — slurmd, receives config via Aura-side scp, supervisord conf
- `ansible/roles/aura_agent_container/` — drops `aura-agent.conf` in supervisord conf.d, no `.service.j2`

**New playbooks**:
- `ansible/bootstrap_container.yml` — bootstraps controller and (if present) worker nodes for container clusters
- `ansible/add_node_container.yml` — adds a worker to an existing container cluster
- `ansible/propagate_config_container.yml` — scp's updated slurm.conf to all worker containers and triggers `scontrol reconfigure`
- `ansible/teardown_container.yml` — stops supervisord-managed processes, removes conf files, cleans state

**New group_vars / template variables**:
- `is_container_cluster: true|false` — switches the slurm.conf template path
- `allow_cross_node_scheduling: true|false` — controls `MaxNodes=1` rendering

**Modified files**:
- `ansible/roles/common/tasks/main.yml` — already cluster-agnostic; verify no systemd assumption (currently uses `service` module — guard with `when: not is_container_cluster`)
- `ansible/roles/chrony/tasks/main.yml` — same: guard the `service` task with `when: not is_container_cluster` (in a container, time sync is the host's responsibility — we skip chrony entirely)
- `ansible/templates/slurm.conf.j2` — add the `MaxNodes=1` conditional render

### 4.3 Web

**Schema and types**:
- `web/prisma/schema.prisma` — add enum + fields
- `web/src/lib/cluster.ts` (or equivalent) — extend `Cluster` TypeScript type
- `web/src/lib/cluster-config.ts` — extend `ClusterConfig` JSON schema validators

**API routes**:
- `web/src/app/api/clusters/route.ts` (POST — create) — accept `clusterType`, `allowCrossNodeScheduling`
- `web/src/app/api/clusters/[id]/route.ts` (PATCH) — allow update of `allowCrossNodeScheduling` (only for `CONTAINER` clusters), trigger config propagate
- `web/src/app/api/clusters/[id]/bootstrap/route.ts` — branch on `clusterType`, dispatch to container or baremetal bootstrap
- `web/src/app/api/clusters/[id]/nodes/route.ts` (POST — add node) — branch on `clusterType`, dispatch to container add_node
- `web/src/app/api/clusters/[id]/config/route.ts` (or propagate route) — branch on `clusterType`
- `web/src/app/api/clusters/[id]/teardown/route.ts` — branch on `clusterType`

**UI components**:
- Cluster create form — `clusterType` selector (Bare Metal / Container), with `allowCrossNodeScheduling` toggle visible only when Container is selected; tooltip text from §5
- Cluster settings page — read-only display of `clusterType` (immutable after create); editable toggle for `allowCrossNodeScheduling` on container clusters
- Cluster overview — type badge ("Bare Metal" or "Container · Single-node only" or "Container · Multi-node")
- Node list — when `clusterType=CONTAINER` and `allowCrossNodeScheduling=false`, the "Add Node" button is disabled with tooltip explaining the toggle must be enabled first
- Warning banner — when `clusterType=CONTAINER`, `allowCrossNodeScheduling=true`, and `data_nfs_server` is empty: "No shared data storage configured. Multi-node jobs will see node-local filesystems only."

### 4.4 Aura agent

No changes to the Go binary itself. Only the deployment surface changes:
- `ansible/roles/aura_agent_container/templates/aura-agent.conf.j2` (new) — supervisord config
- `ansible/roles/aura_agent_container/tasks/main.yml` (new) — installs supervisord conf, no `systemd` handler

## 5. UI copy

### 5.1 Cluster type selector tooltip
> **Bare Metal / VM:** Standard mode for clusters running on dedicated hosts, VMs, or cloud instances. Requires systemd and NFS. Multi-node by default.
>
> **Container:** For clusters running inside containers (RunPod, Lambda Labs, in-house Docker/Kubernetes). Uses supervisord instead of systemd and skips NFS-based config distribution. Recommended for GPU pods provisioned by a third party.

### 5.2 Cross-node scheduling toggle tooltip
> **Allow cross-node scheduling**
>
> When enabled, Slurm will schedule jobs across multiple container worker nodes. Workers must already have direct network connectivity to each other and to the controller.
>
> **Trade-off:** Inter-node collective communications (NCCL, oneCCL, MPI) route over your container network stack. Compared to intra-node NVLink/NVSwitch, the latency penalty is significant — typically 10–100× higher and bandwidth-bottlenecked by the slowest hop. For most distributed training, keeping this **off** and packing all GPUs onto a single large container (e.g. 8×H20) is dramatically faster.
>
> Only enable this if you have high-speed interconnect between containers (RoCE, InfiniBand, or NVLink-over-network) **and** the workload is communication-tolerant.
>
> When disabled, Slurm enforces `MaxNodes=1` on every partition — jobs are guaranteed to run on a single node, no exceptions.

## 6. Testing strategy

### 6.1 Unit tests (web)
- `cluster-create.unit.test.mjs` — validates `clusterType` + `allowCrossNodeScheduling` are accepted, defaulted, and rejected when invalid (e.g. `allowCrossNodeScheduling` on `BAREMETAL` cluster)
- `slurm-conf-render.unit.test.mjs` — confirms partition definition renders with `MaxNodes=1` iff `allowCrossNodeScheduling=false` AND `clusterType=CONTAINER`
- `cluster-route-branching.unit.test.mjs` — confirms bootstrap/add-node/propagate routes dispatch to container playbooks when `clusterType=CONTAINER`

### 6.2 Unit tests (agent / Go)
- Existing `dispatcher_test.go` and `sbatch_test.go` continue to pass; no agent logic changes
- New `setup_handler_test.go` cases for container-mode env passthrough (no systemd-specific code paths to test in the agent — it's the deployment that differs)

### 6.3 Ansible tests
- `molecule/default/` for each new role (`supervisord`, `munge_container`, `slurm_controller_container`, `slurm_worker_container`, `aura_agent_container`) — verifies role idempotency and supervisord conf generation
- `ansible/tests/test_slurm_conf_template.py` — pytest renders the slurm.conf template under the four combinations of `(is_container_cluster, allow_cross_node_scheduling)` and asserts on `MaxNodes` presence

### 6.4 Integration smoke test
- A `docker-compose.test.yml` that brings up two SSH-enabled Ubuntu containers (one labeled controller, one worker), runs `bootstrap_container.yml` + `add_node_container.yml` against them, and verifies `sinfo` shows both nodes idle. Gated behind an env flag (heavy; not in CI by default).

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| supervisord install differs by distro | Pin to apt's `supervisor` package (Ubuntu/Debian only for v1); document as a constraint |
| `apt-get` requires internet from inside the container | Document as a precondition; bootstrap fails fast with a clear message if apt is unreachable |
| NFS client mount fails (no `CAP_SYS_ADMIN`) | Detect the mount failure in the `nfs_client` role and emit a user-facing warning rather than aborting the bootstrap |
| Workers can't reach controller (no L3 connectivity) | slurmd registration times out → `scontrol show nodes` reports `DOWN`; surfaced in node list UI with the explicit cause "Worker cannot reach SlurmctldPort 6817" |
| User toggles cross-node scheduling on a live cluster | Config propagate is idempotent; `scontrol reconfigure` handles the switch without restart |
| `clusterType=CONTAINER` accidentally chosen for a baremetal host | Documented as immutable, but recoverable: teardown + recreate with correct type |
| Migration ordering vs. concurrent upstream changes | This migration uses a high timestamp (20260521…); rebase against `main` before merge to avoid migration ID collisions |

## 8. Release plan

- Feature branch: `feat/container-clusters`
- Target version: `v1.1.0` (minor bump — additive, no breaking changes for existing baremetal clusters)
- Workflows triggered by tag push: `release.yml` (builds image, pushes to ECR), `release-cce.yml` (copies to CCE)
- Pre-tag checks: `npm run build` in `web/`, `go test ./...` in `agent/`, all unit tests green
- Tag is pushed only after explicit user confirmation of the release artifact
