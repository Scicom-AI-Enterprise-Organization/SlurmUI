# Aura

Slurm cluster management platform: a web control plane for provisioning nodes, managing users, and submitting jobs against a Slurm HPC cluster.

## Components

- **`web/`** — Next.js 15 app (control plane UI + API). Uses Prisma, Keycloak for auth, and a custom `server.ts` entrypoint. Dispatches work to agents over NATS.
- **`agent/`** — Go daemon that runs on each managed node. Subscribes to NATS subjects and executes Slurm commands (`sbatch`, `squeue`, `scontrol`, `sinfo`, `scancel`), runs Ansible playbooks for node setup, and streams job output / heartbeats back to the web tier.
- **`ansible/`** — Playbooks and roles for bootstrapping cluster nodes: `slurm_controller`, `slurm_worker`, `munge`, `nfs_server`/`nfs_client`, `sssd`, `chrony`, `aura_agent`, `aura_user`.
- **`docs/`** — Design specs and plans.
- **`test/`** — Integration tests.

## Architecture

```
  ┌──────────┐   NATS   ┌──────────┐   exec   ┌────────┐
  │  web UI  │ ───────► │  agent   │ ───────► │ Slurm  │
  │ (Next.js)│ ◄─────── │   (Go)   │ ◄─────── │ / host │
  └──────────┘          └──────────┘          └────────┘
```

The web tier publishes commands (submit job, add node, provision user, etc.) on NATS subjects. Agents on each node consume the relevant subjects, run the action locally (Slurm CLI or Ansible), and publish results and live output back.

---

## Local Development

### Prerequisites

- Docker + Docker Compose

### 1. Start everything

```bash
docker compose -f docker-compose.dev.yml up -d
```

This starts all services:
- **Web UI** at `http://localhost:3000`
- **Keycloak** at `http://localhost:8080` (admin console: `admin` / `admin`)
- **Postgres** on `localhost:5432`
- **NATS** (JetStream) on `localhost:4222` — monitoring at `http://localhost:8222`
- **Agent** connected to NATS as `local-cluster`

Database migrations run automatically on startup.

### 2. Log in

Open `http://localhost:3000` and log in with:

- **Email:** `admin@aura.local`
- **Password:** `admin`

A second test account is also available:

- **Email:** `user@aura.local`
- **Password:** `user`

These accounts are created by the Keycloak realm import. The `admin@aura.local` user has the `aura-admin` role.

The web service hot-reloads — any changes to files in `web/` are picked up automatically.

---

## Container images

Top-level `Dockerfile` and `web/Dockerfile` / `agent/Dockerfile` build the respective images. `web/docker-compose.yml` brings up the full web stack (no Keycloak — expects external OIDC).

## Cluster bootstrap

```bash
cd ansible
ansible-playbook -i inventory bootstrap.yml
ansible-playbook -i inventory setup_nodes.yml
```
