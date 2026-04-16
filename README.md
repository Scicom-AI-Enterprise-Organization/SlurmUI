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
- Node.js 20+
- Go 1.22+

### 1. Start infrastructure

```bash
docker compose -f docker-compose.dev.yml up -d
```

This starts:
- **Postgres** on `localhost:5432`
- **NATS** (JetStream) on `localhost:4222` — monitoring at `http://localhost:8222`
- **Keycloak** on `http://localhost:8080`

### 2. Configure Keycloak (one-time)

Open `http://localhost:8080` and log in with `admin` / `admin`.

**Create a realm:**
1. Top-left dropdown → **Create realm**
2. Name: `aura-local` → **Create**

**Create a client:**
1. Left sidebar → **Clients** → **Create client**
2. Client ID: `aura-web` → **Next**
3. Enable **Client authentication** → **Next**
4. Valid redirect URIs: `http://localhost:3000/*`
5. Web origins: `http://localhost:3000`
6. **Save**
7. Open the **Credentials** tab — copy the **Client secret**

**Create a role:**
1. Left sidebar → **Realm roles** → **Create role**
2. Role name: `aura-admin` → **Save**

**Create a user:**
1. Left sidebar → **Users** → **Create new user**
2. Username / email / name → **Create**
3. **Credentials** tab → **Set password** (disable Temporary)
4. **Role mapping** tab → **Assign role** → select `aura-admin`

### 3. Configure environment

```bash
cp web/.env.example web/.env.local
```

Edit `web/.env.local`:

```env
DATABASE_URL="postgresql://aura:aura@localhost:5432/aura?schema=public"

NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="any-random-string-for-local-dev"

KEYCLOAK_ID="aura-web"
KEYCLOAK_SECRET="<client-secret-from-step-2>"
KEYCLOAK_ISSUER="http://localhost:8080/realms/aura-local"

NATS_URL="nats://localhost:4222"

# Leave blank for local dev — FreeIPA not required
FREEIPA_URL=""
FREEIPA_USER=""
FREEIPA_PASSWORD=""

ANSIBLE_PLAYBOOKS_DIR="./ansible"
```

### 4. Set up the database

```bash
cd web
npm install
npm run db:push       # apply schema to local Postgres
```

### 5. Start the web app

```bash
npm run dev:custom    # custom server.ts — required for SSE + NATS bridge
```

App runs at `http://localhost:3000`. Log in with the Keycloak user you created.

---

### Agent (optional — for agent development)

The agent needs NATS and a `CLUSTER_ID`. It does not need Slurm to start — it will just fail to execute Slurm commands if they're invoked.

```bash
cd agent
make build-local      # builds ./bin/aura-agent for the host OS/arch

export NATS_URL=nats://localhost:4222
export CLUSTER_ID=local-dev
export ANSIBLE_PLAYBOOK_DIR=../ansible

./bin/aura-agent
```

To connect it to the web, create a cluster record in the DB with the matching `CLUSTER_ID` (use Prisma Studio: `npm run db:studio`).

---

## Container images

Top-level `Dockerfile` and `web/Dockerfile` / `agent/Dockerfile` build the respective images. `web/docker-compose.yml` brings up the full web stack (no Keycloak — expects external OIDC).

## Cluster bootstrap

```bash
cd ansible
ansible-playbook -i inventory bootstrap.yml
ansible-playbook -i inventory setup_nodes.yml
```
