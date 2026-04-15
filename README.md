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

## Development

### Web
```bash
cd web
npm install
npm run db:migrate
npm run dev:custom     # custom server.ts (SSE + NATS bridge)
```

### Agent
```bash
cd agent
make build
./bin/aura-agent --config /etc/aura/agent.yml
```

### Cluster bootstrap
```bash
cd ansible
ansible-playbook -i inventory bootstrap.yml
ansible-playbook -i inventory setup_nodes.yml
```

## Container images

Top-level `Dockerfile` and `web/Dockerfile` / `agent/Dockerfile` build the respective images. `web/docker-compose.yml` brings up the web stack with Keycloak and Postgres.
