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
  nodes, a **Reset Queue** button that scancels zombie pending jobs, and a
  Prometheus `/api/metrics` endpoint for alerts.

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
docker compose -f docker-compose.dev.yml up -d
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

### User-facing pages

- **Dashboard** — last-24h running / completed / failed area chart + status donut; themed via CSS tokens so light/dark/brand switches are automatic.
- **Jobs** — paginated, URL-synced filters (name, status, partition, cluster, date range). **Reset Queue** button sudo-scancels all PENDING jobs.
- **Submit Job** — form mode with common `#SBATCH` fields + Command textarea, or raw script. Example buttons: Hello world, Gloo all-reduce (CPU), NCCL all-reduce (GPU), torchrun training, vLLM serving. Storage working-dir dropdown pulls from your attached mounts; one-click insert of the Python venv activation line.
- **Templates** — save reusable scripts per cluster, re-run with one click.
- **Job detail** — live tail of the Slurm output file via a detached background watcher (survives tab close). **Slurm Info** tab runs `scontrol show job`, `sacct`, `squeue`, `sinfo`, and `scontrol show partition` on demand. Cancel with confirmation dialog.
- **Files** — browse your NFS home plus every attached storage mount via a root dropdown; download files ≤50 MB over SSH.
- **Learn Slurm** (`/explain`) — 16-section practical guide to Slurm concepts, commands, and where each one lives in SlurmUI.

### Observability

- Prometheus scrape endpoint at `GET /api/metrics` (optional `METRICS_TOKEN`
  gate). See [Metrics](#metrics).
- Audit log page shows cluster lifecycle events, job submissions, user
  provisioning, config changes, and accounting mode switches.
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

See `docker-compose.dev.yml` for the full working example.

### Metrics

`/api/metrics` (Prometheus text format). Key series:

- `aura_clusters_total`, `aura_clusters_by_mode`, `aura_cluster_info{name,status,mode}`
- `aura_cluster_nodes{cluster}`, `aura_cluster_storage_mounts{cluster}`, `aura_cluster_packages{cluster}`
- `aura_jobs_total{status}`, `aura_cluster_jobs{cluster,status}`
- `aura_cluster_users{cluster,status}`, `aura_users_total`, `aura_ssh_keys_total`
- `aura_app_sessions`, `aura_background_tasks_total{type,status}`
- `aura_audit_logs_total`, `aura_audit_logs_last_24h{action}`

---

## Deployment

**Dev** — `docker compose -f docker-compose.dev.yml up -d` (see above).

**Prod** — build `web/Dockerfile` and `agent/Dockerfile`; front the web
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
