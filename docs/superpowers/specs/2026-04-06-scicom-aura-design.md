# Scicom Aura — Design Spec
**Date:** 2026-04-06
**Status:** Approved

---

## 1. Overview

Scicom Aura is an end-to-end GPU cluster management platform with two components:

1. **Aura Agent** — a Go binary deployed on each cluster's master node. Executes Slurm commands, runs Ansible playbooks, and communicates exclusively via NATS JetStream. Never exposes a public API.
2. **Aura Web** — a Next.js (TypeScript) application serving both the UI and backend API. Acts as the central control plane for all clusters.

**Goals:**
- Admins can onboard new clusters interactively, manage configs, and propagate changes to all nodes.
- Users can submit Slurm jobs (sbatch/salloc), monitor them with live output, and access their NFS home directory.
- All user identity is managed via a central FreeIPA instance, authenticated through Keycloak.

---

## 2. System Components

| Component | Role | Runs on |
|---|---|---|
| Aura Web | UI + API routes + WebSocket server | Dedicated VM |
| NATS JetStream | Message broker | Same VM as Aura Web |
| PostgreSQL | Persistent store for cluster configs, job history | Same VM as Aura Web |
| Aura Agent | Slurm executor + Ansible runner | Master node of each cluster |
| FreeIPA | Central user/group directory (uid/gid) | Aura Web VM (or dedicated VM) |
| Keycloak | Auth / OIDC provider | Existing infra |

---

## 3. Architecture

### Communication

Aura Web and Aura Agent communicate exclusively through NATS JetStream. The agent never exposes an HTTP or gRPC endpoint. This keeps cluster nodes dark to the public internet.

### NATS Subject Hierarchy

```
aura.cluster.{cluster_id}.command       # Web → Agent (slurm commands)
aura.cluster.{cluster_id}.reply.*       # Agent → Web (command responses)
aura.cluster.{cluster_id}.stream.*      # Agent → Web (live stdout lines)
aura.cluster.{cluster_id}.heartbeat     # Agent → Web (liveness, every 10s)
aura.deploy.{cluster_id}                # Web → Agent (ansible deploy jobs)
```

### Load Balancing (Consumer Groups)

Multiple agent instances on the same master node share a NATS durable consumer on the same `cluster_id` subject. NATS delivers each message to exactly one consumer — no duplicate execution. Adding more agents to a master node scales throughput horizontally.

### Request Flow

```
Browser
  → POST /api/clusters/{cluster_id}/command        (Aura Web API route)
  → NATS: aura.cluster.{cluster_id}.command        (publish)
  → Agent consumes                                  (one of N agents)
  → executes slurm CLI or ansible
  → NATS: aura.cluster.{cluster_id}.stream.*       (live stdout lines)
  → NATS: aura.cluster.{cluster_id}.reply.*        (final result)
  → WebSocket pushes lines to browser    (live output panel)
  → API route returns final response
```

---

## 4. Auth & Identity

### Auth Flow

1. User visits Aura Web → redirected to Keycloak login page
2. Keycloak issues a JWT (contains `sub`, `email`, `groups`)
3. On first login → Aura Web calls FreeIPA API → creates user; FreeIPA assigns the next available `uid/gid` from a configured ID range (e.g. 10000+)
4. JWT is validated on every API request via Next.js middleware
5. Role is extracted from Keycloak group membership: `admin` | `user`
6. FreeIPA provisioning failure on first login → session rejected with a retryable error message

### FreeIPA + SSSD

- One central FreeIPA instance on the Aura Web VM (or a dedicated VM)
- Every cluster node runs SSSD configured to point to the central FreeIPA
- When a new cluster is provisioned, the Ansible bootstrap playbook configures SSSD on all nodes
- When a new user is created in FreeIPA, SSSD propagates the user to all nodes automatically — no per-cluster user management

---

## 5. NFS / Shared Storage

Each cluster has two shared filesystems mounted on all nodes:

| Filesystem | Mount path | Contents | NFS server |
|---|---|---|---|
| mgmt FS | `/mgmt` | munge.key, slurm configs, ansible playbooks | Configurable (`mgmt_nfs_server`) |
| data FS | `/aura-usrdata` | Per-user homedirs (`/aura-usrdata/{uid}/`) | Configurable (`data_nfs_server`) |

Both variables default to the master node IP during cluster onboarding. If a dedicated NFS server (or TrueNAS box) is available, the admin overrides the variables — no playbook changes needed.

> **Note:** `/aura-usrdata` must always be a local on-prem NFS server. Cloud-based NFS (EFS, etc.) introduces too much latency for distributed training workloads.

### User Home Directory Provisioning

1. FreeIPA creates user (uid/gid) on first login
2. SSSD propagates user to all cluster nodes
3. Agent runs Ansible to create `/aura-usrdata/{uid}/` on the data FS
4. User's home directory is accessible from all nodes during job execution

---

## 6. Cluster Onboarding (Admin Wizard)

New cluster provisioning is an interactive multi-step wizard in the Admin UI.

### Step 1 — Basics
- Cluster name
- Master node IP
- SSH credentials (held in memory only during the bootstrap operation, never persisted to DB)

### Step 2 — Storage
- `mgmt_nfs_server` (default: master node IP)
- `data_nfs_server` (default: master node IP)
- mgmt path (default: `/mgmt`)
- data path (default: `/aura-usrdata`)
- Each field has an inline explanation.

### Step 3 — Nodes
Table/list view. Supports individual nodes and Slurm bracket notation:

| Node expression | IP / IP Range | CPUs | GPUs | Memory |
|---|---|---|---|---|
| `slm-node-[01-10]` | `192.168.1.[10-19]` | 32 | 4 | 256GB |
| `slm-node-gpu-01` | `192.168.1.20` | 64 | 8 | 512GB |

Bracket notation maps directly to `slurm.conf` `NodeName` entries — no translation.

### Step 4 — Partitions
List view. Nodes are selected from the expressions defined in Step 3.

| Partition | Nodes | Max Time | Default? |
|---|---|---|---|
| `gpu` | `slm-node-[01-10]` | `24:00:00` | yes |

### Step 5 — Review
- Human-readable summary of what will be provisioned
- Collapsible panel showing the generated `slurm.conf` (for advanced users)
- **"Provision Cluster"** button triggers bootstrap

### Step 6 — Live Provisioning Log
- WebSocket stream of Ansible output, line by line
- Step-by-step progress indicators
- On completion: redirect to cluster dashboard

---

## 7. Bootstrap Flow (New Cluster)

Since no agent exists yet on a new master node, Aura Web runs Ansible directly for bootstrap only. After bootstrap, all operations go through the agent.

```
1. Admin completes wizard → Aura Web:
     - Generates cluster_id
     - Generates NATS credentials for the new agent
     - Stores cluster config in DB
     - Triggers bootstrap playbook (subprocess from Aura Web VM)

2. Bootstrap playbook (SSH into master node):
     - Setup /mgmt and /aura-usrdata NFS exports
     - Install + configure munge (generate key, store in /mgmt)
     - Create slurm user (uid/gid consistent across all nodes)
     - Install slurmctld, slurmdbd, MySQL
     - Configure SSSD → central FreeIPA
     - Write slurm.conf from wizard inputs
     - Deploy Aura Agent binary with cluster's NATS credentials
     - Enable + start agent via systemd
     - For each worker node: run onboard_node.yml

3. Agent starts → sends heartbeats to NATS

4. Aura Web detects first heartbeat → marks cluster "active"

5. UI transitions from "provisioning..." to live cluster dashboard
```

---

## 8. Node States & Registration

### State=FUTURE at Bootstrap

When a node range is declared in the wizard, the full hostname→IP mapping is known upfront. At bootstrap:

- `/etc/hosts` is populated with **all entries** from the declared range on every node
- `slurm.conf` declares all nodes; nodes not physically reachable at bootstrap time are written with `State=FUTURE`
- Slurmctld starts fine — `FUTURE` nodes are reserved slots that don't need to be reachable yet

### Node Activation (within declared range)

When a physical machine within the declared range is ready to join the cluster:

```
1. Admin selects the node (or range) from the UI and triggers "Activate"
2. Aura Web publishes to NATS: aura.deploy.{cluster_id} (type: activate_node)
3. Agent runs onboard_node.yml on the target node:
     - Mount /mgmt and /aura-usrdata
     - Configure SSSD → FreeIPA
     - Copy munge.key from /mgmt
     - Install munge, slurmd
     - Start slurmd
4. Slurm transitions node: FUTURE → DOWN → IDLE
5. Agent replies with sinfo -l output to confirm node is active
```

> No hosts file update needed — the entry was already written at bootstrap.

### Adding a New Node (outside declared range)

```
1. Admin provides new node expression + IP (or bracket range) in UI
2. Aura Web publishes to NATS: aura.deploy.{cluster_id} (type: add_node)
3. Agent:
     a. Verifies new node(s) are reachable
     b. Regenerates /etc/hosts slurm block from full updated node list
        and replaces the block on all existing nodes
     c. Runs onboard_node.yml on each new node
     d. Updates slurm.conf with new node + partition assignment
     e. Runs propagate_config.yml (restarts slurmctld to pick up new node)
4. Agent replies with sinfo -l output to confirm node is visible
```

---

## 9. Config Propagation Flow

```
1. Admin edits slurm config in UI → POST /api/clusters/{id}/config
2. Aura Web validates and stores the new config
3. Publishes deploy job: aura.deploy.{cluster_id} (type: propagate_config)
4. Agent:
     a. Writes updated config files to /mgmt
     b. Runs propagate_config.yml:
          - Copies configs from /mgmt to /etc/slurm on all nodes
          - Restarts slurmctld on master, slurmd on workers
     c. Streams Ansible output back via NATS
5. UI shows live propagation log + final status
```

---

## 10. Job Submission

### sbatch

```
1. User fills job form (script, partition, resource requests)
2. POST /api/clusters/{id}/jobs
3. Agent writes script to temp file, runs:
     sudo -u {username} sbatch /tmp/job-{request_id}.sh
4. Agent streams stdout line-by-line via NATS stream subject
5. Browser WebSocket receives lines → live output panel
6. Agent publishes final result (job_id, exit_code)
7. UI shows Job ID + link to job detail page
```

### salloc (Interactive Session)

```
1. User requests interactive session (Jupyter, terminal, VNC)
2. Agent runs: sudo -u {username} salloc [resource flags]
3. Once allocation granted, agent starts the requested app
4. Agent returns port/URL via NATS reply
5. Aura Web proxies the session URL → user gets a link
   (cluster nodes stay off the public internet)
```

---

## 11. Error Handling

| Scenario | Behaviour |
|---|---|
| Agent unreachable (NATS timeout) | API returns `503` with "agent unreachable" message |
| Agent heartbeat missed 3x | UI marks cluster as `degraded` |
| Ansible task failure | Full stderr streamed to UI, playbook stops, admin sees exact failed task |
| Job failure | Exit code + stderr shown in live output panel |
| FreeIPA provisioning failure on first login | Keycloak session rejected, user sees retryable error |
| Node unreachable during onboarding | Agent reports error, onboarding halts, UI shows which node failed |

---

## 12. Observability

Minimal footprint — no extra monitoring stack required:

- Agent logs to stdout → collected by systemd journal on master node
- Aura Web logs to stdout → collected by host systemd journal or Docker
- NATS built-in monitoring HTTP endpoint for broker health
- Cluster status (`active` / `degraded` / `offline`) derived from heartbeats alone, visible on admin dashboard

---

## 13. Testing Strategy

### Aura Agent (Go)
- Unit tests: command builders (sbatch args, hosts file block sed logic)
- Integration tests: NATS message flow against a local NATS instance
- Slurm commands tested against a real Slurm install in a staging VM

### Aura Web (Next.js)
- Unit tests: auth middleware, NATS message builders
- E2E tests (Playwright): login flow, job submission, cluster onboarding wizard
- Keycloak: use a test realm in E2E (no mocking)

### Ansible Playbooks
- Test against a local VM (Vagrant or libvirt) in CI
- Idempotency check: each playbook runs twice; second run must report zero changes

---

## 14. Repo Structure

```
scicom-aura/
├── agent/                  # Go — Aura Agent binary
│   ├── cmd/
│   ├── internal/
│   │   ├── nats/           # NATS consumer/publisher
│   │   ├── slurm/          # Slurm command wrappers
│   │   ├── ansible/        # Ansible subprocess runner
│   │   └── hosts/          # /etc/hosts block manager
│   └── Makefile
├── web/                    # Next.js — Aura Web
│   ├── app/
│   │   ├── (admin)/        # Admin pages
│   │   ├── (user)/         # User pages
│   │   └── api/            # API routes
│   ├── components/
│   └── lib/
│       ├── nats/           # NATS client
│       ├── auth/           # Keycloak JWT validation
│       └── freeipa/        # FreeIPA API client
├── ansible/                # Ansible playbooks + roles
│   ├── roles/
│   │   ├── common/
│   │   ├── munge/
│   │   ├── slurm_controller/
│   │   ├── slurm_worker/
│   │   └── aura_agent/
│   ├── bootstrap.yml
│   ├── onboard_node.yml
│   └── propagate_config.yml
└── docs/
    └── superpowers/
        └── specs/
```
