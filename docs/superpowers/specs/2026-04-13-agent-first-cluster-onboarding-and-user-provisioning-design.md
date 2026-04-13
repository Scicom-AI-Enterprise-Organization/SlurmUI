# Agent-First Cluster Onboarding & User Provisioning

**Date:** 2026-04-13
**Status:** Approved

---

## Overview

Two features that together replace the current Ansible-from-web bootstrap flow:

1. **Agent-first bootstrap** — admin installs the agent on the master node via a one-liner install script. The web detects the connection and guides the admin through cluster configuration using the live agent.
2. **User provisioning via agent** — admin assigns Keycloak users to clusters. The master agent creates Linux accounts with globally consistent UIDs and replicates them to worker nodes via Ansible.

---

## Feature 1 — Agent-First Cluster Bootstrap

### Phase 1: Get the agent alive

**Wizard steps (reduced from 6 to 2):**

**Step 1 — Basics**
- Cluster name
- Controller hostname

No SSH credentials, no NFS, no node definitions at this stage.

**Step 2 — Install Agent**
- `POST /api/clusters` creates cluster record (`status: PROVISIONING`) and generates an install token stored on the `Cluster` model.
- Token is a UUID, expires 1 hour from creation, single-use.
- Step displays a one-liner:
  ```bash
  curl -fsSL https://aura.aies.scicom.dev/api/install/<token> | bash
  ```
- Web opens SSE to `GET /api/clusters/[id]/heartbeat/stream`, which subscribes to `aura.cluster.<id>.heartbeat` on NATS.
- On first heartbeat: token marked used (`installTokenUsedAt` set), cluster remains `PROVISIONING`, browser transitions to Phase 2.

**Install script** (`GET /api/install/[token]`, no auth required — token is the credential):
1. Downloads agent binary from `GET /api/install/[token]/binary` (web reads from `AURA_AGENT_BINARY_SRC`)
2. Writes `/etc/aura-agent/agent.env`:
   ```
   CLUSTER_ID=<uuid>
   NATS_URL=nats://nats.aura.aies.scicom.dev:4222
   SLURM_USER=slurm
   ANSIBLE_PLAYBOOK_DIR=/opt/aura/ansible
   ```
3. Installs and starts `aura-agent.service` (systemd)

**Token regeneration:**
`POST /api/clusters/[id]/install-token` issues a fresh token (invalidates previous). Available from cluster detail page when token is expired or used.

**Prisma additions to `Cluster`:**
```prisma
installToken          String?   @unique
installTokenExpiresAt DateTime?
installTokenUsedAt    DateTime?
```

---

### Phase 2: Configure the cluster (cluster detail page)

Visible when `status = PROVISIONING`. A sequential vertical stepper — each step is locked until the previous succeeds. Config is saved to `Cluster.config` incrementally after each step. On final step success, cluster moves to `ACTIVE`.

#### Step 1 — NFS

**Form fields:** NFS server IP, mgmt path, data path, allowed network.

**Agent command:** `test_nfs`
- Validates both NFS shares are reachable and mountable
- Streams output

---

#### Step 2 — Nodes

**Form fields:** table of nodes — hostname, IP, CPUs, memory (MB), GPUs (default 0).
**Checkbox:** "Controller node is also a compute node" (master-as-worker).

**Agent command:** `setup_nodes`
- Derives `/etc/hosts` entries from the node table and writes them on master
- Writes Slurm node definitions (`NodeName`, `CPUs`, `RealMemory`, `Gres=gpu:<n>` if GPUs > 0)
- Single payload, single command — hosts file and Slurm node config applied together

---

#### Step 3 — Partitions

**Form fields:** partition name, node expression, max walltime, default flag. Multiple partitions supported.

**Agent command:** `setup_partitions`
- Writes partition definitions into `slurm.conf`
- Restarts `slurmctld`
- Streams output

---

#### Step 4 — Health check

**No form.** "Run health check" button.

**Agent command:** `node_status` (existing)
- Runs `sinfo`, streams output
- On success: cluster status → `ACTIVE`, guided panel replaced by normal cluster detail UI

---

### New agent command handlers required

| Command | Description |
|---|---|
| `test_nfs` | Validates NFS shares, streams mount output |
| `setup_nodes` | Writes `/etc/hosts` + Slurm node config |
| `setup_partitions` | Writes Slurm partition config, restarts slurmctld |

All follow the existing pattern: stream lines via `SendStreamLine`, send final reply via `SendResult`/`SendError`.

---

## Feature 2 — User Provisioning via Agent

### Database changes

**`User` model** — rename FreeIPA fields to Unix identity fields:
```prisma
unixUid    Int?   @unique  // was freeipaUid
unixGid    Int?            // was freeipaGid
clusters   ClusterUser[]
```

**New `ClusterUser` model:**
```prisma
model ClusterUser {
  id            String            @id @default(uuid())
  userId        String
  clusterId     String
  status        ClusterUserStatus @default(PENDING)
  provisionedAt DateTime?
  user          User              @relation(fields: [userId], references: [id])
  cluster       Cluster           @relation(fields: [clusterId], references: [id])

  @@unique([userId, clusterId])
}

enum ClusterUserStatus {
  PENDING
  ACTIVE
  FAILED
}
```

**`Cluster` model** — add:
```prisma
clusterUsers  ClusterUser[]
```

---

### UID allocation

- Global, not per-cluster. A user gets one UID assigned on first provisioning and reuses it across all clusters.
- Ensures NFS home dir ownership is consistent regardless of which cluster mounts it.
- Allocation: `SELECT MAX(unixUid) + 1 FROM users WHERE unixUid IS NOT NULL`, starting from 10000 if no users have a UID yet.
- GID = UID (user's primary group is their own group).

---

### New agent command: `provision_user`

**Payload:**
```json
{
  "username": "john.doe",
  "uid": 10003,
  "gid": 10003,
  "nfs_home": "/aura-usrdata/john.doe",
  "worker_hosts": [
    { "hostname": "node-01", "ip": "192.168.1.10" }
  ]
}
```

**Prerequisite:** The cluster SSH key must be present on the master node (configured during Phase 2 setup) so the agent can run Ansible against worker nodes.

**Agent execution on master:**
1. `groupadd -g <gid> <username>`
2. `useradd -u <uid> -g <gid> -d <nfs_home> -M <username>` (`-M` skips local home creation)
3. `mkdir -p <nfs_home> && chown <uid>:<gid> <nfs_home>` (creates home on NFS mount)
4. Runs `user_provision.yml` Ansible playbook against all worker nodes:
   - Creates same group + user with identical UID/GID
   - Does not create home dir on workers (comes from NFS)
5. Streams all output, replies with result

---

### New API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/clusters/[id]/users` | List provisioned users + status |
| `POST` | `/api/clusters/[id]/users` | Provision a user to this cluster |
| `DELETE` | `/api/clusters/[id]/users/[userId]` | Deprovision (placeholder, out of scope) |

**`POST /api/clusters/[id]/users` body:** `{ userId: string }`

Flow:
1. Load user from DB; allocate `unixUid`/`unixGid` if not yet assigned (update User record)
2. Create `ClusterUser` record with status `PENDING`
3. Load worker hosts from `Cluster.config`
4. Send `provision_user` command via `publishCommand` (non-blocking, returns `request_id`)
5. Return `{ request_id }` — client streams progress via existing `/api/clusters/[id]/stream/[requestId]` SSE endpoint
6. When the SSE reply event arrives (`type: "complete"`), client calls `PATCH /api/clusters/[id]/users/[userId]` with `{ status: "ACTIVE" | "FAILED" }` to finalize the record

---

### New Ansible playbook: `user_provision.yml`

Runs against worker nodes. Creates group + user with specified UID/GID. Does not touch home directory.

---

### Admin UI

**"Users" tab on cluster detail page** (only visible for `ACTIVE` clusters):
- Table: name, email, UID, status badge (PENDING / ACTIVE / FAILED)
- "Add User" button → modal with searchable dropdown of all users → "Provision" button
- Live log stream shown inline after provisioning is triggered (same SSE pattern as other operations)

---

## What is explicitly out of scope

- User deprovisioning (removing a Linux user from a cluster)
- SSH key injection for users (users interact via Aura only; direct SSH is a manual admin task)
- FreeIPA / LDAP integration
- The old 6-step Ansible bootstrap wizard (replaced entirely by Phase 1 + Phase 2)

---

## Rollout order

1. Feature 1 — Phase 1 (install script, token, heartbeat detection, wizard rework)
2. Feature 1 — Phase 2 (guided setup stepper, 3 new agent commands)
3. Feature 2 — User provisioning (DB migration, new command, API, UI)

Feature 2 depends on Feature 1 (agent must be installed and cluster `ACTIVE` before users can be provisioned).
