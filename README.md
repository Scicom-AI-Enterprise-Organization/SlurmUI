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
  manage Linux users, invite teammates via one-time links (ADMIN or VIEWER),
  and flip accounting / scheduling modes without shelling into the controller.
- **For users** — browse NFS + object storage, submit batch jobs from a form or
  raw editor (with ready-to-run examples), save reusable templates, watch job
  output live, expose a running job's HTTP/WebSocket service through Aura
  (Jupyter, vLLM OpenAPI, TensorBoard, …) via a per-job reverse proxy, and
  read an in-app "Learn Slurm" guide.
- **For on-call** — one-click node diagnostics (ping, port probes, chrony,
  slurmd status, recent logs), a **Fix** button that resumes stuck CG/DRAIN
  nodes, a **Reset Queue** button that scancels zombie pending jobs, a
  periodic **health monitor** that tracks slurmctld, node state, storage
  mounts, and stuck/held jobs (firing webhooks to Slack / Teams on every
  transition), and a Prometheus `/api/metrics` endpoint for alerts.
- **For disaster recovery & migration** — one-way **Git Sync** exports every
  cluster's config, SSH keys (optional), and job history as YAML into a git
  repo; a **Restore from git** button rebuilds a fresh SlurmUI from that repo.
- **For GitOps workflows** — point **Git Jobs** at a repo of YAML manifests
  (`jobs/**/*.yaml`) and the reconciler submits new jobs, cancel-and-resubmits
  on content change, and cancels jobs whose manifest was deleted. Optional
  one-way mirror of live PENDING/RUNNING jobs back into `running/` in the
  same repo. Off by default; enable + schedule (min 180 s) from settings.

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

### Run it on Linux

```bash
git clone https://github.com/your-org/aura.git
cd aura
docker compose -f docker-compose.dev.yml up --build
```

**Only works on Linux because use `network_mode: host`**.

Open [http://localhost:3000](http://localhost:3000) and log in with **`admin@aura.local`** / **`admin`** (Keycloak), or use the email-and-password form for accounts created via **invite link** (see [Identity & access](#identity--access)).

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
   controller. In **bastion mode** the controller is auto-seeded as a node
   before bootstrap runs, so `slurm.conf` boots with a valid single-node
   `PartitionName=main` out of the gate — no extra step needed for a
   single-host cluster. (The seeded node is visible on the Nodes tab with
   a banner explaining it's safe to delete if you only want to submit
   against workers.)
3. **Nodes → Add Node** for each worker (skip this on a single-host bastion
   cluster). SlurmUI auto-detects CPUs / GPUs / memory / topology via an
   SSH probe and writes a correct `NodeName=` line. A small
   `RealMemory` safety margin is baked in so slurmctld's floor check
   never fails on MemTotal drift.
4. **Partitions → Apply to Cluster**, then **Users → Add User** for yourself.
5. Hit **Submit Job**, pick "Hello world", Submit.

### Spin a throwaway cluster with Multipass

If you don't have a real cluster handy, [Multipass](https://multipass.run/) gives
you an Ubuntu VM in one command — perfect for end-to-end testing of bootstrap,
add-node, job submit, etc.

```bash
sudo snap install multipass
multipass launch 24.04 --name aura-test --cpus 2 --memory 8G --disk 40G
multipass info aura-test           # note the IPv4 — that's your controller host
```

> **Disk space tip** — Multipass stores VM images under `/var/snap/multipass/common/data/multipassd/vault`,
> which lives on `/`. If that's tight, bind-mount the vault to a roomier disk
> *before* launching anything:
> ```bash
> sudo snap stop multipass
> sudo mkdir -p /path/with/space/multipass-vault
> sudo rsync -a /var/snap/multipass/common/data/multipassd/vault/ /path/with/space/multipass-vault/
> sudo rm -rf /var/snap/multipass/common/data/multipassd/vault
> sudo mkdir /var/snap/multipass/common/data/multipassd/vault
> sudo mount --bind /path/with/space/multipass-vault /var/snap/multipass/common/data/multipassd/vault
> sudo snap start multipass
> ```
> Use `mount --bind` rather than a symlink — Multipass's AppArmor policy rejects
> paths outside `/var/snap/...`. Add the bind to `/etc/fstab` to persist across
> reboots.

Then in SlurmUI's **New Cluster**:

| Field | Value |
|---|---|
| Controller host | IP from `multipass info aura-test` |
| SSH user | `ubuntu` |
| SSH port | `22` |
| Bastion | **off** |

Pick whichever SSH key path you prefer:

- **Reuse Multipass's bundled key** (zero setup): paste the contents of
  `sudo cat /var/snap/multipass/common/data/multipassd/ssh-keys/id_rsa` into
  the private-key field.
- **Generate a fresh key from the UI** (cleaner): click **Generate** in the
  New Cluster dialog, copy the public key it shows, then inject it into the
  VM:
  ```bash
  multipass exec aura-test -- bash -c \
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
     echo '<paste-pubkey>' >> ~/.ssh/authorized_keys && \
     chmod 600 ~/.ssh/authorized_keys"
  ```

Click **Bootstrap**, wait for the log to finish, and you've got a working
single-node cluster. To add a worker, `multipass launch ... --name aura-worker`
and use **Nodes → Add Node** with that VM's IP. Tear everything down with
`multipass delete --purge aura-test aura-worker`.

---

## Features

### Cluster admin — setting tabs

| Tab | What it does |
|---|---|
| **Configuration** | Raw `cluster.config` JSON editor with secrets masked (S3 keys, tokens — re-merged from DB on save). Slurm Accounting card toggles between `accounting_storage/none` and `slurmdbd + MariaDB`, plus one-click **FIFO priority** for scheduler-stuck queues. |
| **SSH** | Manage the key that reaches the controller, test connectivity, bastion toggle. Bastion mode uses `-tt` PTYs with marker-framed commands; enable `AURA_BASTION_MUX` for a long-lived multiplexed shell per cluster to skip the per-call login + ~2 s PTY bootstrap. |
| **Nodes** | Bootstrap, Add, Delete, Terminal, Logs, **Fix** (resume + kill stuck CG jobs + bounce slurmd), **Diagnose** (ping / TCP 6818 / slurmd status / chrony / recent slurmd logs), **Sync /etc/hosts** (distribute hostname→IP maps across the fleet and verify worker-to-worker connectivity). |
| **Partitions** | Define named queues, assign nodes via checkboxes, Apply rewrites `PartitionName=` lines and restarts `slurmctld`. |
| **Storages** | Attach NFS / S3fs mounts, Deploy to every worker, per-mount health column, Remove with confirmation. |
| **Packages** | Apt packages installed cluster-wide; per-package per-node status column. **Remove** runs `apt-get remove` + `autoremove` on every worker and only strips the entry from the stored config after the SSH script actually succeeds — no optimistic drift. Live log dialog on both Install and Remove. |
| **Python** | Shared or per-node venv managed by [`uv`](https://docs.astral.sh/uv/). Pick Python version and storage location. Per-package `--index-url` / `--extra-index-url`, plus a "paste a `pip install` command" parser. Version shown per installed package. **Uninstall** runs `uv pip uninstall` (not `python -m pip` — uv-managed venvs have no bundled pip) on the shared venv or on each node in per-node mode; a node failure flips the task to `failed` and keeps the chip in the table. |
| **Environment** | Cluster-wide env vars (optionally Secret) rendered into `/etc/profile.d/aura.sh` on every node. Status column confirms each key is present. |
| **Users** | Two sub-tabs (URL-synced via `?tab=`). **Users** — live listing from the controller: `getent passwd` (uid ≥ 1000) joined with `sacctmgr show user`, deduped by uid so SSSD/LDAP aliases collapse, with a `presence` badge (`linux + slurm` / `linux` / `slurm`) and an `unmanaged` flag for anything not tracked by Aura. Provision / deprovision still creates the Linux account, NFS home, and Slurm accounting entry. **Account tree** — indent-collapse tree of the Slurm accounting hierarchy, parsed from `sacctmgr show associations`. Click a node to inspect: fairshare (with `% of siblings`), default QoS, GrpTRES, MaxJobs/MaxSubmit, parent. Full CRUD on accounts and per-user associations (`sacctmgr add/modify/delete account` + `add/modify/delete user`). Root is protected from deletion, and repeat `(user, partition)` association rows from `sacctmgr` are collapsed. |
| **Queue** | Sortable `squeue` with pending-reason grouping, per-row **hold / release / requeue / terminate** buttons (via sudo `scontrol` / `scancel`, admin-only, audit-logged), `sprio -l` priority breakdown, `sinfo -R` down-node reasons, partition state, `sshare` fairshare, `sacctmgr` QOS limits, and `sdiag` scheduler stats — all via SSH, no agent. |
| **Reservations** | List/create/delete Slurm reservations (`scontrol create reservation`). Dialog has native datetime pickers for start / end, multiselect for nodes (live `sinfo`) and users (cluster-provisioned, submitted as their unix usernames), partition dropdown, plus a read-only **command preview** textarea showing the exact `scontrol` invocation before it runs. |
| **QoS** | CRUD over `sacctmgr qos` entries — Name, Priority, MaxJobsPU, MaxSubmitPU, MaxWall, MaxTRESPU, MaxTRESPJ, GrpTRES, GrpJobs, Flags. Edit reuses the same dialog as create; empty fields are left unchanged on edit, `-1` clears a limit. Requires `slurmdbd`. Built-in `normal` QoS is protected from deletion. |
| **Metrics** | Per-node `node_exporter` (host CPU/RAM/disk/net on `:9100`) + auto-detected GPU exporter on `:9400` — DCGM via docker on bare-metal/VM, [`nvidia_gpu_exporter`](https://github.com/utkuozdemir/nvidia_gpu_exporter) binary in container hosts. Reuses pre-existing exporters when they're already exposed on `0.0.0.0`; rebinds loopback-only listeners. Optional Prometheus + Grafana stack (binary install + systemd, no docker) deployed to the controller or any worker; storage path and per-stack ports configurable. Optional **Loki + promtail** toggle adds log aggregation alongside the metrics stack — promtail ships systemd journals + `/mnt/shared/*.out` job stdout to Loki with the Slurm jobid extracted as a label. Auto-provisions the upstream [gpu-metrics-exporter dashboards](https://github.com/Scicom-AI-Enterprise-Organization/gpu-metrics-exporter/tree/main/dashboards) plus four vLLM dashboards (classic / v1 / v2 + minimal) shipped from `web/dashboards/`, with their `${DS_PROMETHEUS}` / `mimir` / `victoria-metrics-prom` datasource refs rewritten on deploy. Per-row **Diagnose** (probes both ports, dumps systemd / docker / `nvidia-smi -L`) and a stack-wide **Logs** dropdown (journalctl tail of Prometheus / Grafana / Loki). Loopback-only bindings show as an amber `loopback only` badge with a tooltip explaining the scrape failure. |

### User-facing pages

- **Dashboard** — last-24h running / completed / failed area chart + status donut; themed via CSS tokens so light/dark/brand switches are automatic.
- **Jobs** — paginated, URL-synced filters (name, status, partition, cluster, date range). **Reset Queue** button sudo-scancels all PENDING jobs. Per-row **Restart** button on FAILED jobs does a fresh `sbatch` of the stored script through a background task and opens a live log dialog — footer flips to a **Go to job `<id>`** deep-link once the new job row is created. **Cluster resources** panel above the filters shows live free vs total CPU cores, memory (GiB), and GPUs across the cluster, with a per-node breakdown under each resource (sorted by most-free; drained / down nodes struck through).
- **Submit Job** — form mode with common `#SBATCH` fields + Command textarea, or raw script. Example buttons: Hello world, Gloo all-reduce (CPU), NCCL all-reduce (GPU), torchrun training, vLLM serving. **Load from template** dropdown under each Examples row — in Form mode it parses the template's `#SBATCH` directives into the fields and drops the remainder into Command; in Raw mode it drops the script verbatim. **Nodes** multiselect pins the job to specific hosts via `--nodelist` (sourced from live `sinfo`). Storage working-dir dropdown pulls from your attached mounts; one-click insert of the Python venv activation line. **Resource availability gate** in form mode polls `/resources` and disables the Submit button (with an amber per-resource shortage list) when the request exceeds free CPUs / GPUs / memory cluster-wide — saves a round-trip to `PD: Resources` queue limbo.
- **Templates** — save reusable scripts per cluster, re-run with one click, or load into the Submit Job form for tweaks.
- **Job detail** — live tail of the Slurm output file via a detached background watcher (survives tab close). **Resync state** button re-queries `squeue`/`sacct` and overwrites the DB status (fixes rows stuck after an SSH hiccup, without clobbering when Slurm returns nothing). **Stderr** tab (detects merged vs separate). **Usage** tab for running jobs samples each allocated node and shows per-node CPU cores used, RAM, per-GPU utilization / memory, and top processes scoped to the job via `scontrol listpids` + cgroup fallback — auto-refresh 30 s. **Slurm Info** tab runs `scontrol show job -dd`, `sacct` with full resource fields (MaxRSS, DerivedExitCode, Reason, …), `sprio`, `squeue`, `sinfo`, `scontrol show partition` on demand. **Dependencies** tab renders the local DAG (parents → this job → children) parsed from `Dependency=afterok:N,afterany:M` plus a `squeue`/`sacct` reverse scan for downstream jobs; deep-links to other Aura Job rows when the Slurm id maps. **Expose metrics** tab toggles Prometheus scrape on a per-job port (e.g. vLLM's `:8000/metrics`) — saving runs a pre-flight probe and refuses unscrapable ports. **Proxy** tab toggles a per-job HTTP+WebSocket reverse proxy at `/job-proxy/<clusterId>/<jobId>/*` so users can hit a running job's web UI / API directly from a browser tab — see [Job proxy](#job-proxy) for details. Both running-only tabs are disabled when the job isn't `RUNNING`. On `FAILED` / `CANCELLED` jobs, an inline **error explainer** above the tabs pattern-matches stderr / output / Slurm Info against ~20 well-known failure modes (cgroup OOM, CUDA OOM, time-limit, NVIDIA XID 79 / ECC / clocking, NCCL / Gloo init, partition / QoS / Assoc limits, Munge auth, NFS stale, driver mismatch, ssh publickey, …) and explains each in plain English with a `user fix` vs `ops` tag and a concrete next step. Cancel with confirmation dialog.
- **Files** — browse your NFS home plus every attached storage mount via a root dropdown; download files ≤50 MB over SSH.
- **Metrics** — six native Recharts panels (GPU utilization, GPU memory %, GPU temp, GPU power, host CPU %, host memory %) with 5m / 15m / 1h / 6h / 24h range selector and 30 s auto-refresh. PromQL queries are union'd across DCGM and `nvidia_smi` exporter metric names so either mode renders. **Open Grafana** button reverse-proxies the cluster's Grafana UI through this app at `/grafana-proxy/<clusterId>/` (no iframe — Grafana served on Aura's origin) — one-shot SSH local port-forward per cluster, basic-auth injected server-side using the rotating admin password, no Grafana login screen.
- **Proxies** — cluster-level listing of every job that has the **Proxy** tab toggled on. Cards show job name + optional label (e.g. "Jupyter", "vLLM"), Slurm id, partition, submitter, the proxy URL, an **Open** button (disabled when the job isn't `RUNNING`), and a trash button to remove the proxy via a confirmation dialog. Auto-refreshes every 10 s. See [Job proxy](#job-proxy) for the underlying mechanism.
- **Profile** (`/profile`) — your identity card, Linux account (copy-to-clipboard for username / UID / GID), cluster provisioning table, and activity totals (jobs submitted, running, templates saved). Local-login accounts can change their own password here.
- **Learn Slurm** (`/explain`) — 16-section practical guide to Slurm concepts, commands, and where each one lives in SlurmUI.

### Global admin settings

Under **/admin/settings** (sub-sidebar):

| Page | What it does |
|---|---|
| **SSH Keys** | Generate or import SSH key pairs, see which clusters use each, delete unused. |
| **Alerts** | Webhook channels for Slack, Teams, or generic JSON. Per-channel event filter (glob like `cluster.*` or specific actions), optional cluster scoping, and a **pre-create test** that has to succeed before the channel can be saved. Fed by `logAudit` and by the health monitor for transitions (`cluster.unreachable/recovered`, `node.unhealthy/recovered`, `storage.disconnected/reconnected`, `job.stuck`, `job.held`). |
| **Git Sync** | Configure a backing git repo; one-way export of state, and **Restore from git** for migrating to a new SlurmUI. |
| **Git Jobs** | Separate GitOps loop for *job submission* — clone a repo, scan `jobs/**/*.yaml`, and reconcile against the Job table (submit new, cancel-and-resubmit on content change, cancel-and-drop on deletion). Also **Mirror running jobs**, a one-way push of every live PENDING/RUNNING job into `running/<cluster>/<slurmId>.yaml`. Off by default; interval clamped to ≥ 180 s. |

The admin sidebar also has a dedicated **/admin/organization** page (below)
for user / invite management.

### Identity & access

Two authentication paths stand side-by-side:

1. **Keycloak SSO** — the primary provider. Realm / client / group roles
   mapped to `ADMIN` if any of `aura-admin` / `admin` is present, else
   `VIEWER`. Upsert on first sign-in, re-checked on every token refresh.
2. **Email + password** — for local accounts created through an invite
   link. Passwords are bcrypt-hashed; Keycloak-only rows (no `passwordHash`)
   can't use this path.

Two roles only:

| Role | What it can do |
|---|---|
| `ADMIN` | Everything — manage clusters, users, invites, Git Jobs, etc. |
| `VIEWER` | Read-only. Middleware rejects any non-GET API call with HTTP 403. |

**Organization page** (`/admin/organization`) drives the whole flow:

- **Invite by link** — pick role (Admin/Viewer), optional email lock,
  expiry (default 24 h, max 30 days). Raw token is shown **once** in a
  copy-link dialog and never echoed again. The recipient opens
  `/invite/<token>`, sets name + password, and is auto-signed-in; the
  invite is single-use and expires on first claim.
- **Members table** — change role (confirm dialog, can't demote yourself),
  delete user (confirm dialog, refuses if they own jobs), generate a
  **password reset link** for local accounts.
- **Password reset link** — admin issues `/reset/<token>` (1 h expiry,
  single-use, also invalidates any other outstanding reset tokens on
  success). Delivered out-of-band; the user sets a new password and is
  auto-signed-in. Keycloak users are rejected — change those in Keycloak.
- **Pending invites** — see outstanding ones with a masked token preview;
  revoke with one click.

Public routes (no auth required) are tightly scoped: `/login`,
`/invite/[token]`, `/reset/[token]`, and their matching
`/api/invites/by-token/*` / `/api/password-reset/by-token/*` endpoints.
Everything else requires a session; non-admin mutating calls are blocked
at the middleware layer.

### Git Jobs (GitOps for job submission)

Separate from Git Sync, **Git Jobs** treats a git repo as the source of
truth for *what should run*. Admin settings live at
**/admin/settings/gitops-jobs**.

Manifest format (`<repo>/[path/]jobs/**/*.yaml`):

```yaml
apiVersion: aura/v1
kind: Job
metadata:
  name: train-001              # unique per cluster — identifies the job lineage
  cluster: gpu-a               # cluster name (must exist in SlurmUI)
  user: alice@example.com      # must match a User.email
spec:
  partition: gpu
  script: |
    #!/bin/bash
    #SBATCH --gres=gpu:1
    srun python train.py
```

Reconciler loop (off by default; interval ≥ 180 s):

- New manifest → submit via the same internal helper as the REST
  `POST /api/clusters/[id]/jobs` route (`lib/submit-job.ts`).
- Content hash changed → cancel running job + delete row + resubmit
  (detected via `sha256(yaml)` stored in `Job.sourceRef`).
- Manifest removed from repo → cancel + drop.
- Unchanged → skip.

Idempotency comes from `@@unique([clusterId, sourceName])` on `Job`, so the
same manifest name always maps to one job lineage per cluster.

**Mirror running jobs** (on-demand button, no toggle required beyond
`repoUrl` being set) overwrites `<path>/running/<cluster>/<slurmId>.yaml`
with snapshots of every live PENDING/RUNNING job and commits + pushes. The
reconciler never reads `running/`, so the mirror can coexist with
declarative submissions without loops.

Auth is identical to Git Sync — HTTPS PAT, deploy key, or inline
credentials. Read-only access is sufficient for reconcile; write is only
needed for the mirror.

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

### Public API (`/api/v1`)

Everything admins and users can do from the UI has a session-gated REST
endpoint, but for programmatic use (CI pipelines, external schedulers,
notebook scripts) there's a curated **`/api/v1`** surface that takes a
Bearer token.

- **Mint tokens** at **/profile/api-tokens** (copy-once dialog, prefix +
  last-used are all that's persisted afterwards; revoke anytime).
- **Docs + curl examples** at **/api-docs** (the same base URL as the
  running UI; examples adapt to the page origin).
- **Auth** — `Authorization: Bearer aura_<…>`. Session cookies also
  work, so the same routes back your own UI integrations. VIEWER role
  can list but not submit; non-admins see only their own jobs.

Endpoints today:

| Method | Path | What it does |
|---|---|---|
| `GET`  | `/api/v1/clusters` | List clusters the caller can see (id, name, mode, status, partitions, default partition, node count). |
| `POST` | `/api/v1/clusters/:cluster/jobs` | Submit a job. Body `{script, partition?, name?}`. `:cluster` accepts name or UUID. Returns `{id, slurmJobId, status, …}` 201. |
| `GET`  | `/api/v1/clusters/:cluster/jobs` | Paginated list with `status` / `partition` / `name` / `from` / `to` filters. |
| `GET`  | `/api/v1/jobs/:id` | Job detail. `?output=1` tacks on the last 1 MB of stdout over SSH. |
| `POST` | `/api/v1/jobs/:id/resync` | Re-query Slurm (`squeue` + `sacct`) and overwrite the DB row's status / exit code. Use this when the tail-based watcher missed a terminal transition (stuck `RUNNING` after bastion drop, output file on an unmounted path, etc.). |
| `POST` | `/api/v1/jobs/:id/cancel` | `scancel --signal=KILL --full` on the controller, flips the DB row to `CANCELLED`. Safe to call on already-terminal jobs. |

Data model is identical to the UI — tokens inherit the owner's role,
submit audits are tagged with `via: "api/v1"`, and jobs submitted over
the API show up alongside UI-submitted ones in the dashboard / Jobs
list.

Tests under `web/test/`, runnable with plain `node:test` — no extra deps:

| File | Type | What it covers |
|---|---|---|
| `api-auth.unit.test.mjs` | Unit | `generateToken()` shape / prefix / URL-safe alphabet, `hashToken()` determinism + avalanche, 1000-iter uniqueness, no silent whitespace trimming. |
| `api-v1.test.mjs` | Integration | End-to-end against a live SlurmUI: auth gates (401/403), `list clusters`, `list jobs`, `submit`, poll to terminal, `get job` with `?output=1`, plus filter enforcement. Uses a Gloo all-reduce script. |

```bash
# pure-logic unit tests (no server needed)
node --test --test-reporter=spec web/test/api-auth.unit.test.mjs

# full integration (real POST + SSH + slurm queue)
export AURA_BASE=http://localhost:3000
export AURA_TOKEN=aura_...                     # from /profile/api-tokens
export AURA_CLUSTER=my-cluster                 # name or uuid
node --test --test-reporter=spec web/test/api-v1.test.mjs
```

Route handlers get their coverage through the integration test — they
`import` from `next/server`, which can't be loaded under a vanilla
`node:test` process without a Next-aware runner.

### Job proxy

Per-job HTTP + WebSocket reverse proxy at
`/job-proxy/<clusterId>/<jobId>/*` so users can reach a running job's web
UI directly from a browser. Generic — works for vLLM's OpenAPI docs,
Jupyter, TensorBoard, MLflow, Streamlit, custom FastAPI / Flask / Express
apps. Toggle from the **Proxy** tab on the job detail page (port +
optional label); listing on the cluster's **Proxies** tab.

Network path: workers usually live on a private network only the
controller can reach, so the web server can't TCP-connect to
`<workerIP>:<port>` directly. Aura solves this with a per-`(clusterId,
jobId)` SSH local port-forward (`ssh -N -L <localport>:<workerIP>:<port>`)
through the controller — same pattern as the Grafana proxy. The HTTP
route fetches `http://127.0.0.1:<localport>/<path>`; the WebSocket
upgrade hook in `server.ts` opens a raw socket to the same local port and
pipes both directions. Tunnels are cached in-memory and rebuilt lazily on
socket-level errors.

Path semantics:

- The `/job-proxy/<clusterId>/<jobId>` prefix is **stripped** before
  forwarding upstream — `/job-proxy/.../docs` arrives at the service as
  `/docs`. Matches the convention most lightweight services expect (and
  what vLLM ships with — there's no `--root-path` flag).
- `X-Forwarded-Prefix: /job-proxy/<clusterId>/<jobId>` is sent so prefix-
  aware frameworks (FastAPI `root_path` with proxy headers, Werkzeug,
  Spring's `ForwardedHeaderFilter`) emit correctly-prefixed absolute
  links.
- HTML response bodies have absolute-path quoted strings (`href="/foo"`,
  `url: "/openapi.json"`) rewritten to include the prefix so the
  browser's next request lands back at the proxy.
- JSON responses with an `openapi` (3.x) or `swagger` (2.0) field get a
  `servers: [{ url: "/job-proxy/<clusterId>/<jobId>" }]` injected (or
  `basePath` for Swagger 2.0) so Swagger UI's "Try it out" curl examples
  build URLs against the proxy instead of the page origin.
- 3xx `Location` headers pointing at absolute paths are rewritten the
  same way.

Auth: ADMIN, the job submitter, or any active `ClusterUser` member of
the same cluster. The session JWT is decoded directly in the WS upgrade
hook (NextAuth doesn't offer a route-handler equivalent for raw upgrades).

The Proxy and Expose-metrics tabs both **disable themselves** when the
job isn't `RUNNING` — saving a port for a non-running job has no useful
effect.

> **Dev caveat** — `docker-compose.dev.yml` runs `next dev`, which
> bypasses the custom `server.ts` entrypoint. The HTTP side of the
> proxy works in dev as-is; WebSocket upgrades only fire under the
> custom server. Switch the dev `command` to `npm run dev:custom`
> (`tsx server.ts`) when you need to test WS proxying locally —
> production images already use `server.ts`.

### Observability

- Prometheus scrape endpoint at `GET /api/metrics` (optional `METRICS_TOKEN`
  gate). See [Metrics](#metrics).
- **Per-cluster metrics stack** (admin Metrics tab). Installs `node_exporter`
  (host) and a GPU exporter (DCGM via docker, or `nvidia_gpu_exporter` binary)
  on selected nodes, and optionally deploys a Prometheus + Grafana pair as
  systemd services on the controller or any worker. Auto-detects and reuses
  pre-existing exporters bound to `0.0.0.0`; rebinds loopback-only listeners.
  Provisions the upstream
  [gpu-metrics-exporter dashboards](https://github.com/Scicom-AI-Enterprise-Organization/gpu-metrics-exporter/tree/main/dashboards)
  plus four vLLM dashboards (classic / v1 / v2 exports + a hand-rolled
  minimal one) shipped from `web/dashboards/`, with their
  `${DS_PROMETHEUS}` / `mimir` / `victoria-metrics-prom` references
  rewritten to the local Prometheus uid at deploy time. Grafana is
  reverse-proxied through Aura at `/grafana-proxy/<clusterId>/` over a
  per-cluster SSH local port-forward (`-tt` + `sleep` keepalive for
  bastion-mode controllers); Basic auth injected server-side using a
  rotating admin password so users never see Grafana's login screen. The
  proxy also rewrites Grafana's baked `root_url` on the fly so a deploy
  from one origin (e.g. dev `localhost:3001`) still renders correctly when
  accessed from prod (`https://aura.example.com`). Grafana Live
  (WebSocket) is disabled at deploy since route handlers can't proxy WS —
  dashboards refresh on interval.
- **Optional log aggregation** (Loki + promtail). Toggle in the Metrics
  tab settings deploys a single-binary Loki on the same stack host (with
  retention enforced by the compactor) and provisions promtail on every
  exporter-enabled node, shipping systemd journals (`slurmd`,
  `slurmctld`) plus job stdout from `/mnt/shared/*.out`. Promtail extracts
  the Slurm jobid from filenames (`<name>-<id>.out`) so log queries can
  filter by `{job="slurm-output", jobid="1234"}`. Disabling the toggle
  and re-deploying sweeps Loki off the stack host AND promtail off every
  node in one pass.
- **Per-job Prometheus scrape** ("Expose metrics" tab on the Job detail
  page). Sets a `metricsPort` on a Job and Aura rebuilds Prometheus's
  `file_sd_configs` (`/etc/prometheus/sd/jobs.json`) from the DB, hot-
  reloading via `/-/reload`. Each running node-pair gets labels `job=
  aura-job`, `aura_jobid`, `slurm_jobid`, `user`, `cluster`. The vLLM
  dashboards pivot on the vLLM-emitted `model_name` label so multiple
  replicas of the same model auto-aggregate. A pre-flight probe
  (`/metrics/refresh-targets` companion endpoint
  `/jobs/[jobId]/check-port`) curls each running node before saving and
  refuses unscrapable ports — no permanent red Prometheus targets.
  Controls are disabled (with a friendly banner explaining why) when the
  cluster's Prometheus isn't deployed or isn't responding.
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
                          └──────────────┬──────────────┘
                                         │
                ┌────────────────────────┼────────────────────────┐
                │                        │                        │
            SSH mode                 NATS mode               Observability
                ▼                        ▼                        ▼
       ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
       │ ssh (+ bastion) │      │ NATS JetStream  │      │  /api/metrics   │
       │  → controller   │      │   → agent (Go)  │      │  (Prometheus)   │
       │  → workers      │      │   → slurmd/ctld │      │                 │
       └─────────────────┘      └─────────────────┘      └─────────────────┘
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
3. A fire-and-forget IIFE kicks off `sshExecScript(target, script, { onStream, onComplete, timeoutMs })` and registers the child process handle in an in-process cancel registry. The `timeoutMs` override lets long admin flows (bootstrap, node deploy, package install) push past the 60 s default that's fine for short commands.
4. `onStream` appends every log line to `BackgroundTask.logs` via a per-task serialized queue so writes don't race. Scripts emit a `[trace] bash exiting (status=N)` line on EXIT so the bastion ssh layer can close the channel immediately — without that trace, bastions routinely hold the `-tt` PTY open until the idle fallback fires.
5. Client polls `/api/tasks/[taskId]` every 2s — dialog shows live logs even if you refresh / navigate away / re-open the tab.
6. Cancel dispatches `POST /api/tasks/[taskId]/cancel`, which SIGTERMs (then SIGKILLs) the SSH process and flips the task row to `failed` synchronously so the dialog doesn't sit in "Cancelling…" for minutes while `dpkg` drains.

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
| `AURA_SSH_MUX` | Enable OpenSSH `ControlMaster` multiplexing for non-bastion clusters. Dramatically reduces latency on polled endpoints (e.g. `/jobs/:id/output`) by reusing one SSH connection per target instead of re-handshaking every call. `1` = on. | `0` |
| `AURA_SSH_MUX_PERSIST_SEC` | How long the SSH master is kept alive after last use (OpenSSH `ControlPersist`). | `600` |
| `AURA_SSH_MUX_TTL_MS` | Server-side cache eviction TTL for mux entries. Keep `≤ AURA_SSH_MUX_PERSIST_SEC * 1000`. | `600000` |
| `AURA_SSH_MUX_POOL_SIZE` | Max ControlMaster masters per target; round-robin'd per call. One master already multiplexes many channels (`sshd` `MaxSessions`, default 10) — raise this when you exceed that cap or want to isolate a stuck master. | `1` |
| `AURA_BASTION_MUX` | Keep one long-lived `ssh -tt` shell per bastion cluster and frame commands with markers — skips the per-call handshake and 1.5 s PTY bootstrap. Applies only when the cluster is in bastion mode. `1` = on. | `0` |
| `AURA_BASTION_MUX_TTL_MS` | Idle TTL for a bastion session in ms. | `600000` |
| `AURA_BASTION_MUX_READY_MS` | Warm-up deadline for a new bastion session in ms. | `30000` |
| `AURA_BASTION_MUX_EXEC_MS` | Per-exec deadline in ms. A command exceeding this aborts and recycles the session. | `600000` |
| `AURA_BASTION_MUX_POOL_SIZE` | Max parallel `ssh -tt` shells per bastion target. Each shell serves one command at a time; N of them run concurrently, new shells spawn lazily when existing ones are busy. | `5` |

See `docker-compose.dev.yml` for the full working example.

### Metrics

This section documents Aura's own control-plane scrape endpoint (`slurmui_*`
counters about clusters, jobs, queue, etc.). For **per-cluster GPU + host**
metrics from the cluster nodes themselves, see the
[per-cluster metrics stack](#observability) under Features.

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
   - Wiring an existing Slurm feature into a new settings tab (Licenses, Topology, preemption policies, etc.).
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
- Two-way GitOps: webhook-driven reconcile on `git push`, drift detection, PR-review workflow (one-way Git Sync + polling Git Jobs reconciler already shipped).
- Self-serve "forgot password" flow (admin-issued reset links are already available).

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
