# scripts/

Helper scripts for local development and end-to-end testing.

| Script | What it does |
|---|---|
| [`spin-multipass-cluster.sh`](./spin-multipass-cluster.sh) | Stands up a throwaway Slurm test cluster on [Multipass](https://multipass.run/): 1 master, 2 workers, 1 jumphost/bastion. Generates an SSH key, wires passwordless access between all nodes, and optionally exposes the bastion via a LAN port-forward or a Cloudflare quick-tunnel. |

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
