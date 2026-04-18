<div align="center">

# SlurmUI

**A modern web control plane for Slurm.**

Provision nodes, manage users and storage, submit & monitor jobs — from a browser.
Works with existing Slurm clusters over SSH (no agent required) or with a lightweight
Go agent over NATS when you want pushed-state and no open SSH ports.

[Features](#features) · [Quick start](#quick-start) · [Architecture](#architecture) · [Configuration](#configuration) · [Contributing](#contributing)

</div>

---

## Why SlurmUI

Slurm is the industry-standard HPC scheduler, but most teams end up with a mix of
`ssh` sessions, hand-written ops runbooks, and Ansible roles to run it. SlurmUI
wraps the day-to-day operations in a single web UI:

- **For admins** — bootstrap a fresh controller, add/remove nodes, edit
  partitions, install apt/pip packages cluster-wide, mount NFS or S3 storage,
  manage Linux users, and flip accounting / scheduling modes without shelling
  into the controller.
- **For users** — browse NFS + object storage, submit batch jobs from a form or
  raw editor (with ready-to-run examples), save reusable templates, watch job
  output live, and read an in-app "Learn Slurm" guide.
- **For on-call** — one-click node diagnostics (ping, port probes, chrony,
  slurmd status, recent logs), a **Fix** button that resumes stuck CG/DRAIN
  nodes, a **Reset Queue** button that scancels zombie pending jobs, a
  periodic **health monitor** that tracks slurmctld, node state, storage
  mounts, and stuck/held jobs (firing webhooks to Slack / Teams on every
  transition), and a Prometheus `/api/metrics` endpoint for alerts.
- **For disaster recovery & migration** — one-way **Git Sync** exports every
  cluster's config, SSH keys (optional), and job history as YAML into a git
  repo; a **Restore from git** button rebuilds a fresh SlurmUI from that repo.

Two connection modes, pick whichever fits your network:

| Mode | How it reaches the cluster | When to use |
|---|---|---|
| **SSH** | SlurmUI SSHes to the controller (optionally through a bastion), controller SSHes to workers | Existing clusters, air-gapped networks where only SSH is open, fastest to try |
| **NATS** | Each node runs the `agent` binary and subscribes to NATS | Push model, no inbound SSH to nodes, cleaner for large fleets |

Every long-running action (bootstrap, add-node, package install, storage
deploy, partition apply, environment apply, fix-node, enable accounting, etc.)
runs as a **detached background task**: close the dialog, come back in a
minute, click the same button and reattach to the live log. Every task has a
**Cancel** button that kills the underlying SSH process.

---

## Quick start

### Requirements

- Docker + Docker Compose
- 4 GB free RAM

### Run it

```bash
git clone https://github.com/your-org/aura.git
cd aura
docker compose -f docker-compose.dev.yml up --build
```

Open [http://localhost:3000](http://localhost:3000) and log in with **`admin@aura.local`** / **`admin`**.

This brings up:

| Service | Port | Purpose |
|---|---|---|
| Web UI + API | `:3000` | Next.js control plane |
| Keycloak | `:8080` | OIDC identity (admin/admin on the admin console) |
| Postgres | `:5432` | Cluster + job metadata |
| NATS JetStream | `:4222` (monitor `:8222`) | Agent ↔ web bus |
| Go agent | — | Demo agent speaking to NATS as `local-cluster` |

Prisma migrations run automatically on first boot. Source changes in `web/`
hot-reload; source changes in `agent/` need `docker compose restart agent`.

### First cluster

1. **Clusters → New Cluster** → paste your controller host + an SSH private
   key (the UI generates one if you don't have one). Check **bastion** if
   your SSH host only allows interactive shells.
2. Click **Bootstrap** on the cluster. The dialog streams the log as Slurm,
   munge, chrony, NFS, and a minimal `slurm.conf` are installed on the
   controller.
3. **Nodes → Add Node** for each worker. SlurmUI auto-detects CPUs / GPUs /
   memory / topology via an SSH probe and writes a correct `NodeName=` line.
4. **Partitions → Apply to Cluster**, then **Users → Add User** for yourself.
5. Hit **Submit Job**, pick "Hello world", Submit.

---

## Features

### Cluster admin — setting tabs

| Tab | What it does |
|---|---|
| **Configuration** | Raw `cluster.config` JSON editor with secrets masked (S3 keys, tokens — re-merged from DB on save). Slurm Accounting card toggles between `accounting_storage/none` and `slurmdbd + MariaDB`, plus one-click **FIFO priority** for scheduler-stuck queues. |
| **SSH** | Manage the key that reaches the controller, test connectivity, bastion toggle. |
| **Nodes** | Bootstrap, Add, Delete, Terminal, Logs, **Fix** (resume + kill stuck CG jobs + bounce slurmd), **Diagnose** (ping / TCP 6818 / slurmd status / chrony / recent slurmd logs), **Sync /etc/hosts** (distribute hostname→IP maps across the fleet and verify worker-to-worker connectivity). |
| **Partitions** | Define named queues, assign nodes via checkboxes, Apply rewrites `PartitionName=` lines and restarts `slurmctld`. |
| **Storages** | Attach NFS / S3fs mounts, Deploy to every worker, per-mount health column, Remove with confirmation. |
| **Packages** | Apt packages installed cluster-wide; per-package per-node status column. |
| **Python** | Shared or per-node venv managed by [`uv`](https://docs.astral.sh/uv/). Pick Python version and storage location. Per-package `--index-url` / `--extra-index-url`, plus a "paste a `pip install` command" parser. Version shown per installed package. |
| **Environment** | Cluster-wide env vars (optionally Secret) rendered into `/etc/profile.d/aura.sh` on every node. Status column confirms each key is present. |
| **Users** | Provision / deprovision Linux accounts + NFS home + Slurm accounting per cluster. |
| **Queue** | Sortable `squeue` with pending-reason grouping, per-row **hold / release / requeue** buttons (via sudo `scontrol`, admin-only, audit-logged), `sprio -l` priority breakdown, `sinfo -R` down-node reasons, partition state, `sshare` fairshare, `sacctmgr` QOS limits, and `sdiag` scheduler stats — all via SSH, no agent. |

### User-facing pages

- **Dashboard** — last-24h running / completed / failed area chart + status donut; themed via CSS tokens so light/dark/brand switches are automatic.
- **Jobs** — paginated, URL-synced filters (name, status, partition, cluster, date range). **Reset Queue** button sudo-scancels all PENDING jobs. **Cluster resources** panel above the filters shows live free vs total CPU cores, memory (GiB), and GPUs across the cluster, with a per-node breakdown under each resource (sorted by most-free; drained / down nodes struck through).
- **Submit Job** — form mode with common `#SBATCH` fields + Command textarea, or raw script. Example buttons: Hello world, Gloo all-reduce (CPU), NCCL all-reduce (GPU), torchrun training, vLLM serving. **Load from template** dropdown under each Examples row — in Form mode it parses the template's `#SBATCH` directives into the fields and drops the remainder into Command; in Raw mode it drops the script verbatim. **Nodes** multiselect pins the job to specific hosts via `--nodelist` (sourced from live `sinfo`). Storage working-dir dropdown pulls from your attached mounts; one-click insert of the Python venv activation line.
- **Templates** — save reusable scripts per cluster, re-run with one click, or load into the Submit Job form for tweaks.
- **Job detail** — live tail of the Slurm output file via a detached background watcher (survives tab close). **Resync state** button re-queries `squeue`/`sacct` and overwrites the DB status (fixes rows stuck after an SSH hiccup, without clobbering when Slurm returns nothing). **Stderr** tab (detects merged vs separate). **Usage** tab for running jobs samples each allocated node and shows per-node CPU cores used, RAM, per-GPU utilization / memory, and top processes scoped to the job via `scontrol listpids` + cgroup fallback — auto-refresh 30 s. **Slurm Info** tab runs `scontrol show job -dd`, `sacct` with full resource fields (MaxRSS, DerivedExitCode, Reason, …), `sprio`, `squeue`, `sinfo`, `scontrol show partition` on demand. Cancel with confirmation dialog.
- **Files** — browse your NFS home plus every attached storage mount via a root dropdown; download files ≤50 MB over SSH.
- **Learn Slurm** (`/explain`) — 16-section practical guide to Slurm concepts, commands, and where each one lives in SlurmUI.

### Global admin settings

Under **/admin/settings** (sub-sidebar):

| Page | What it does |
|---|---|
| **SSH Keys** | Generate or import SSH key pairs, see which clusters use each, delete unused. |
| **Alerts** | Webhook channels for Slack, Teams, or generic JSON. Per-channel event filter (glob like `cluster.*` or specific actions), optional cluster scoping, and a **pre-create test** that has to succeed before the channel can be saved. Fed by `logAudit` and by the health monitor for transitions (`cluster.unreachable/recovered`, `node.unhealthy/recovered`, `storage.disconnected/reconnected`, `job.stuck`, `job.held`). |
| **Git Sync** | Configure a backing git repo; one-way export of state, and **Restore from git** for migrating to a new SlurmUI. |

### Git sync & migration

Point SlurmUI at a private git repo (SSH deploy key or HTTPS PAT, optionally username:password inline in the URL). **Sync now** commits every cluster's YAML, attached SSH key metadata, optionally the private key material, and the most recent 500 jobs. Layout:

```
clusters/<name>/{cluster,config,partitions,nodes,storage,packages-apt,
                 packages-python,environment,users}.yaml
ssh-keys/_index.yaml
ssh-keys/private/<key>.key   # only when "Include secrets" is on
jobs/<cluster>/<date>/<id>.yaml
```

**Restore from git** (same page) upserts clusters by name and SSH keys by name
into a new SlurmUI. Live clusters aren't touched; re-Apply each settings tab
to push state back to nodes after restore.

### Observability

- Prometheus scrape endpoint at `GET /api/metrics` (optional `METRICS_TOKEN`
  gate). See [Metrics](#metrics).
- **Periodic health monitor** (`SLURMUI_HEALTH_INTERVAL_SEC`, default 60 s)
  SSHes to every ACTIVE / DEGRADED cluster, collects `scontrol ping`,
  `sinfo -h -N`, `squeue` with reason & submit time, and per-worker `mountpoint`
  checks. Transitions are written to the audit log and fan out to alert
  webhooks. Stuck pending jobs (dependency never satisfied, held, or long-pending)
  fire `job.stuck` / `job.held`. Auto-downgrades cluster status
  ACTIVE ↔ DEGRADED based on controller reachability.
- Audit log page shows cluster lifecycle events, job submissions, user
  provisioning, config changes, and accounting mode switches — with from/to
  date filters.
- Every long-running task is a row in the `BackgroundTask` table with
  timestamps and accumulated logs.

---

## Architecture

```
                         ┌─────────────────────────────┐
                         │   Next.js control plane     │
                         │ (Prisma · Keycloak OIDC)    │
                         └─────────────┬───────────────┘
                                       │
                ┌──────────────────────┼──────────────────────┐
                │                      │                      │
     SSH mode  ▼                 NATS mode  ▼           Observability
   ┌───────────────────┐      ┌───────────────────┐    ┌────────────────┐
   │ ssh (+ bastion)   │      │ NATS JetStream    │    │ /api/metrics   │
   │   → controller    │      │   → agent (Go)    │    │  (Prometheus)  │
   │     → workers     │      │     → slurmd/slurmctld│    │                │
   └───────────────────┘      └───────────────────┘    └────────────────┘
```

### Repository layout

| Path | What's there |
|---|---|
| `web/` | Next.js 15 app (App Router). Prisma schema, API routes, UI. Custom `server.ts` entrypoint. |
| `agent/` | Go daemon for NATS-mode clusters. Ansible runner, Slurm CLI wrappers, publisher/subscriber loops. |
| `ansible/` | Roles for `slurm_controller`, `slurm_worker`, `munge`, `nfs_{server,client}`, `sssd`, `chrony`, `aura_agent`, `aura_user`, plus `bootstrap.yml`, `add_node.yml`, `user_{provision,deprovision}.yml`. |
| `docs/` | Design specs and implementation plans. |
| `test/` | Integration tests (Vagrant + in-container). |

### Data flow for a long-running action

1. Web UI POSTs to an API route (e.g. `POST /api/clusters/[id]/packages`).
2. Route creates a `BackgroundTask` row, returns `{ taskId }` immediately.
3. A fire-and-forget IIFE kicks off `sshExecScript(target, script, { onStream, onComplete })` and registers the child process handle in an in-process cancel registry.
4. `onStream` appends every log line to `BackgroundTask.logs`.
5. Client polls `/api/tasks/[taskId]` every 2s — dialog shows live logs even if you refresh / navigate away / re-open the tab.
6. Cancel dispatches `POST /api/tasks/[taskId]/cancel`, which SIGTERMs (then SIGKILLs) the SSH process.

---

## Configuration

### Environment variables

| Var | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | — |
| `NEXTAUTH_URL` | Public URL of the web tier | `http://localhost:3000` |
| `NEXTAUTH_SECRET` | Session secret | — |
| `KEYCLOAK_ID` / `KEYCLOAK_SECRET` / `KEYCLOAK_ISSUER` | OIDC client | — |
| `NATS_URL` | NATS server used for NATS-mode clusters | `nats://localhost:4222` |
| `ANSIBLE_PLAYBOOKS_DIR` | Host path of `ansible/` inside the web container | `/opt/aura/ansible` |
| `METRICS_TOKEN` | Bearer token for `/api/metrics` (empty = public) | empty |
| `SLURMUI_HEALTH_INTERVAL_SEC` | Health-monitor poll interval (clamped to ≥ 15) | `60` |
| `SLURMUI_STUCK_JOB_THRESHOLD_SEC` | Pending-job age before `job.stuck` fires for non-progress reasons | `600` |

See `docker-compose.dev.yml` for the full working example.

### Metrics

`/api/metrics` (Prometheus text format, `slurmui_*` namespace). Highlights:

**Clusters & capacity**

- `slurmui_clusters_total{status}`, `slurmui_clusters_by_mode{mode}`, `slurmui_clusters_by_bastion{bastion}`
- `slurmui_cluster_info{cluster,cluster_id,status,mode,bastion}` — metadata, value always 1
- `slurmui_cluster_nodes{cluster}`, `slurmui_cluster_cpus_total{cluster}`, `slurmui_cluster_gpus_total{cluster}`, `slurmui_cluster_memory_mb_total{cluster}`
- `slurmui_cluster_partitions{cluster}`, `slurmui_cluster_partition_nodes{cluster,partition}`
- `slurmui_cluster_storage_mounts{cluster}`, `slurmui_cluster_storage_mounts_by_type{cluster,type}`
- `slurmui_cluster_apt_packages{cluster}`, `slurmui_cluster_python_packages{cluster}`, `slurmui_cluster_env_vars{cluster}`
- `slurmui_cluster_age_seconds{cluster}`

**Jobs**

- `slurmui_jobs_total{status}`, `slurmui_cluster_jobs{cluster,status}`
- `slurmui_cluster_partition_jobs{cluster,partition,status}`
- `slurmui_jobs_by_exit_code{exit_code}`
- `slurmui_jobs_24h{status}`, `slurmui_jobs_1h{status}`, `slurmui_jobs_5m{status}` — rate-friendly windows
- `slurmui_jobs_running_count{cluster}`, `slurmui_running_job_age_seconds{stat=min|p50|p90|p99|max|count}`
- `slurmui_job_duration_seconds_{bucket,count,sum}{cluster,status,le}` — Prometheus histogram over the 24h finished-job window
- `slurmui_cluster_last_submit_timestamp_seconds{cluster}`, `slurmui_cluster_last_finished_timestamp_seconds{cluster}`

**Queue state (from health monitor)**

- `slurmui_queue_pending_jobs{cluster}`, `slurmui_queue_running_jobs{cluster}`, `slurmui_queue_held_jobs{cluster}`
- `slurmui_queue_oldest_pending_seconds{cluster}`
- `slurmui_queue_pending_by_reason{cluster,reason}` — time-series per Slurm reason code (`Resources`, `Priority`, `Dependency`, `QOSMaxJobsPerUserLimit`, …)
- `slurmui_queue_stuck_jobs{cluster}` — classified stuck by the health monitor

**Cluster health (from health monitor)**

- `slurmui_health_slurmctld_up{cluster}`, `slurmui_health_last_check_age_seconds{cluster}`, `slurmui_health_poll_errors{cluster}`
- `slurmui_health_nodes_total{cluster}`, `slurmui_health_nodes_unhealthy{cluster}`, `slurmui_health_nodes_by_state{cluster,state}`
- `slurmui_health_node_up{cluster,node,state}` — one series per node
- `slurmui_health_storage_mounted{cluster,host,mount_path,mount_id}` — 1/0 per worker × mount
- `slurmui_health_jobs_tracked{cluster}`

**Users / templates / sessions**

- `slurmui_users_total{role}`, `slurmui_cluster_users{cluster,status}`
- `slurmui_top_user_jobs_24h{cluster,user}` — top 20, bounded cardinality
- `slurmui_cluster_templates{cluster}`, `slurmui_templates_total`
- `slurmui_app_sessions{cluster,type,status}`

**SSH keys & git sync**

- `slurmui_ssh_keys_total`, `slurmui_ssh_keys_unused`, `slurmui_ssh_key_clusters_using{key}`
- `slurmui_git_sync_enabled`, `slurmui_git_sync_last_sync_timestamp_seconds`, `slurmui_git_sync_last_success`

**Ops / background**

- `slurmui_background_tasks_total{status}`, `slurmui_background_tasks_by_type{type,status}`
- `slurmui_background_tasks_running{cluster,type}`, `slurmui_background_task_oldest_age_seconds`
- `slurmui_background_tasks_failed_24h{type}`
- `slurmui_audit_logs_24h{action}`, `slurmui_audit_logs_1h{action}`, `slurmui_audit_logs_total`
- `slurmui_scrape_timestamp_seconds`, `slurmui_scrape_duration_seconds`

---

## Deployment

**Dev** — `docker compose -f docker-compose.dev.yml up -d` (see above).

**Prod-like local stack** — `docker compose -f docker-compose.prod.yml up -d --build` builds the real prod image (root `Dockerfile`, `npm run build`, `server.ts` compiled to an ESM bundle, no `tsx` at runtime) and wires it up against postgres / nats / keycloak / the Go agent. Same default CMD (`node -r ./preload.cjs server.mjs`) as K8s/ArgoCD.

**Prod** — build the root `Dockerfile` (builds agent binaries for amd64+arm64, the web image, and bundles the Ansible playbooks) and `agent/Dockerfile`; front the web
service with your own reverse proxy (TLS, auth proxy if you don't use
Keycloak), point `DATABASE_URL` at managed Postgres, and either:

- expose NATS JetStream for agents to dial into (NATS mode), or
- give the web container an SSH key it can use to reach your controllers (SSH mode).

The web service is stateless; scale horizontally behind any load balancer.
Background tasks currently track SSH processes in-process, so a task kicked
off on replica A can only be cancelled from replica A (logs are still
visible from any replica since they live in Postgres). We plan to move the
cancel registry to Redis for multi-replica deployments.

---

## Contributing

Contributions welcome — big or small.

1. Fork, clone, `docker compose -f docker-compose.dev.yml up -d`.
2. Find a rough edge. Common starting points:
   - A new example in the Submit Job form (add a `FORM_EXAMPLES` / `RAW_EXAMPLES` entry).
   - A new node-level `Fix` / `Diagnose` step.
   - Wiring an existing Slurm feature into a new settings tab (QoS, Reservations, etc.).
3. Match the existing style: server-side background tasks for anything touching the cluster, `redactConfig` for anything that may hold a secret, prefer dialogs over toasts for non-trivial feedback.
4. Open a PR. Include screenshots for UI changes.

**Issue tags to look for:**
- `good-first-issue` — scoped, self-contained, no cluster needed to reproduce.
- `help-wanted` — welcome to take on, drop a comment so we don't duplicate work.

### Local checks

```bash
cd web
npm run lint
npm run typecheck
npm test
```

---

## Roadmap

Near-term:
- Multi-replica cancel registry (Redis).
- Resource dashboard per user (GPU-hours, queue time percentiles).
- FreeIPA integration for centralized users (already stubbed in config).
- Agent auto-update channel.
- Two-way GitOps: webhook-driven reconcile on `git push`, drift detection, PR-review workflow (MVP one-way sync + restore already shipped).

Longer term:
- Multi-tenant quotas via `sacctmgr` fair-share automation.
- Cost attribution reports.
- Native integration with JupyterHub / Ray spawners.

---

## License

MIT. See [`LICENSE`](LICENSE).

## Credits

SlurmUI is built on top of excellent open-source work:

- [Slurm Workload Manager](https://slurm.schedmd.com/)
- [Next.js](https://nextjs.org/), [Prisma](https://www.prisma.io/), [Radix UI](https://www.radix-ui.com/), [Recharts](https://recharts.org/)
- [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream)
- [Keycloak](https://www.keycloak.org/)
- [uv](https://docs.astral.sh/uv/)
