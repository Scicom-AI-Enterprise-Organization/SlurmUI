"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, Copy, KeyRound, Search } from "lucide-react";
import Link from "next/link";

/**
 * API reference page — three-column layout modelled on the api.png
 * mock: endpoint nav on the left, docs in the middle, code samples
 * pinned to the right. Each endpoint section repeats the same shape
 * (description → parameters → request sample → response sample) so the
 * page reads like a generated reference.
 *
 * Response examples come straight from the real route handlers; if you
 * change a route's wire shape, update its entry in ENDPOINTS below.
 */

// Inline copy feedback — swaps the icon to a checkmark for ~1.5 s on
// click instead of firing a toast. Less intrusive and the affordance
// stays inside the box you just clicked.
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="absolute right-1.5 top-1.5 opacity-50 hover:opacity-100"
      onClick={onClick}
      title={copied ? "Copied" : "Copy"}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

// Single-bordered code block matching the InfoCard shape (Base URL /
// Authentication header / Quick start). One rounded border around the
// whole thing — label and code share the same surface, no internal
// separator line. Theme-aware via `bg-muted`.
function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <div className="relative rounded-md border bg-muted p-3">
      {label && (
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
      )}
      <pre className="overflow-x-auto pr-8 font-mono text-xs leading-relaxed text-foreground/90">
        {children}
      </pre>
      <CopyBtn text={children} />
    </div>
  );
}

function MethodBadge({ method, size = "sm" }: { method: "GET" | "POST" | "DELETE"; size?: "sm" | "xs" }) {
  const colour =
    method === "GET" ? "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200"
    : method === "POST" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
    : "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200";
  const sizing = size === "xs"
    ? "h-4 px-1 text-[9px]"
    : "h-5 px-1.5 text-[10px]";
  return (
    <span className={"inline-flex items-center rounded font-mono font-semibold tracking-wider " + sizing + " " + colour}>
      {method}
    </span>
  );
}

function StatusBadge({ code, label }: { code: number; label: string }) {
  const ok = code >= 200 && code < 300;
  const colour = ok
    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
    : "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200";
  return (
    <span className={"inline-flex h-5 items-center rounded px-1.5 font-mono text-[10px] font-semibold " + colour}>
      {code} {label}
    </span>
  );
}

interface Endpoint {
  id: string;
  group: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  navLabel: string;
  title: string;
  description: React.ReactNode;
  parameters?: Array<{ name: string; in: "query" | "body" | "path"; type: string; required?: boolean; doc: React.ReactNode }>;
  request: { sample: string };
  responses: Array<{ code: number; codeLabel: string; doc?: React.ReactNode; sample: string }>;
}

interface Group {
  id: string;
  title: string;
  blurb?: React.ReactNode;
}

const GROUPS: Group[] = [
  { id: "clusters", title: "Clusters", blurb: <>Discover the clusters this token can submit to.</> },
  { id: "jobs", title: "Jobs", blurb: <>Submit, list, inspect, resync and cancel jobs.</> },
  { id: "provisioning", title: "Provisioning", blurb: <>Synchronous endpoints for bootstrap, accounting, node management, log fetching, and ad-hoc exec. Useful for CLI / CI loops. Admin only.</> },
  { id: "admin", title: "Admin & Maintenance", blurb: <>Operator-only endpoints. Tokens minted by an <code>ADMIN</code>-role user.</> },
];

const ENDPOINTS: Endpoint[] = [
  {
    id: "list-clusters",
    group: "clusters",
    method: "GET",
    path: "/api/v1/clusters",
    navLabel: "List clusters",
    title: "List clusters",
    description: <>Returns the clusters this token can submit to. Admins see every cluster; regular users see only the ones they&apos;re provisioned on.</>,
    request: {
      sample: `curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  $AURA_BASE/api/v1/clusters | jq`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK",
        sample: `{
  "clusters": [
    {
      "id": "752cbab8-635f-406c-99a0-84bafc669a91",
      "name": "tm",
      "mode": "SSH",
      "status": "ACTIVE",
      "bastion": false,
      "createdAt": "2026-01-12T03:14:22.000Z",
      "partitions": ["main", "gpu"],
      "defaultPartition": "main",
      "nodeCount": 4
    }
  ]
}`,
      },
    ],
  },
  {
    id: "submit-job",
    group: "jobs",
    method: "POST",
    path: "/api/v1/clusters/:cluster/jobs",
    navLabel: "Submit a job",
    title: "Submit a job",
    description: (
      <>
        <p>
          <code>:cluster</code> accepts the cluster&apos;s UUID or its <code>name</code>.
          When <code>name</code> is set and the script doesn&apos;t already have a
          <code className="mx-1">#SBATCH --job-name=</code> line we inject one.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Names must contain no whitespace. A submission is rejected with <code>502</code>
          if a job with the same name is already <b>RUNNING</b> on the cluster
          (per <code>squeue</code>).
        </p>
      </>
    ),
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID or human name." },
      { name: "script", in: "body", type: "string", required: true, doc: "Full SBATCH script. Must include a shebang and the SBATCH directives Slurm needs." },
      { name: "partition", in: "body", type: "string", doc: "Defaults to the cluster's default partition." },
      { name: "name", in: "body", type: "string", doc: "Cosmetic job name. Injected as `#SBATCH --job-name=` when not present in the script." },
    ],
    request: {
      sample: `curl -s -X POST "$AURA_BASE/api/v1/clusters/my-cluster/jobs" \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d @- <<'EOF'
{
  "name": "hello",
  "partition": "main",
  "script": "#!/bin/bash\\n#SBATCH --time=00:01:00\\nhostname\\ndate\\nsleep 5\\necho done"
}
EOF`,
    },
    responses: [
      {
        code: 201,
        codeLabel: "Created",
        sample: `{
  "id": "9f1d83c4-9a2e-4711-9b3f-37b5b3cd2e1c",
  "slurmJobId": 184,
  "clusterId": "752cbab8-635f-406c-99a0-84bafc669a91",
  "partition": "main",
  "status": "PENDING",
  "createdAt": "2026-05-07T03:21:08.000Z"
}`,
      },
      {
        code: 502,
        codeLabel: "Bad Gateway",
        doc: "Slurm rejected the submission, or the chosen name collides with a RUNNING job.",
        sample: `{
  "error": "Job name \\"training\\" is already in use by a RUNNING job on this cluster (per squeue). Cancel it, wait for it to finish, or pick a different name."
}`,
      },
    ],
  },
  {
    id: "list-jobs",
    group: "jobs",
    method: "GET",
    path: "/api/v1/clusters/:cluster/jobs",
    navLabel: "List jobs",
    title: "List jobs",
    description: <>Returns jobs visible to the calling token, newest first. Non-admins see only their own jobs.</>,
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID or human name." },
      { name: "page", in: "query", type: "number", doc: "1-indexed page number. Defaults to 1." },
      { name: "limit", in: "query", type: "number", doc: "Page size, capped at 100. Defaults to 20." },
      { name: "status", in: "query", type: "string", doc: "PENDING / RUNNING / COMPLETED / FAILED / CANCELLED." },
      { name: "partition", in: "query", type: "string", doc: "Exact partition name." },
      { name: "name", in: "query", type: "string", doc: "Substring match on the script body, case-insensitive." },
      { name: "from", in: "query", type: "ISO date", doc: "Lower bound on createdAt (inclusive)." },
      { name: "to", in: "query", type: "ISO date", doc: "Upper bound on createdAt (inclusive)." },
    ],
    request: {
      sample: `curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/clusters/my-cluster/jobs?status=RUNNING&limit=20"`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK",
        sample: `{
  "jobs": [
    {
      "id": "9f1d83c4-9a2e-4711-9b3f-37b5b3cd2e1c",
      "slurmJobId": 184,
      "clusterId": "752cbab8-635f-406c-99a0-84bafc669a91",
      "userId": "u_3d2a...",
      "partition": "main",
      "status": "RUNNING",
      "exitCode": null,
      "sourceName": null,
      "createdAt": "2026-05-07T03:21:08.000Z",
      "updatedAt": "2026-05-07T03:21:11.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 47, "pages": 3 }
}`,
      },
    ],
  },
  {
    id: "get-job",
    group: "jobs",
    method: "GET",
    path: "/api/v1/jobs/:id",
    navLabel: "Get one job",
    title: "Get one job",
    description: <><code>:id</code> is the DB uuid returned by submit / list — not the Slurm job id. Append <code>?output=1</code> to additionally fetch the last ~1 MB of the job&apos;s stdout file over SSH.</>,
    parameters: [
      { name: "id", in: "path", type: "uuid", required: true, doc: "DB uuid of the job (from /jobs response)." },
      { name: "output", in: "query", type: "boolean", doc: "Set to 1 to include a tail of the stdout file." },
    ],
    request: {
      sample: `curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/jobs/$JOB_ID?output=1" | jq`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK · without output",
        sample: `{
  "job": {
    "id": "9f1d83c4-9a2e-4711-9b3f-37b5b3cd2e1c",
    "slurmJobId": 184,
    "clusterId": "752cbab8-635f-406c-99a0-84bafc669a91",
    "userId": "u_3d2a...",
    "name": "training-run",
    "partition": "main",
    "status": "COMPLETED",
    "exitCode": 0,
    "script": "#!/bin/bash\\n#SBATCH --job-name=training-run\\n…",
    "sourceRef": null,
    "sourceName": null,
    "metricsPort": null,
    "proxyPort": null,
    "proxyName": null,
    "proxyPublic": false,
    "createdAt": "2026-05-07T03:21:08.000Z",
    "updatedAt": "2026-05-07T03:48:31.000Z"
  }
}`,
      },
      {
        code: 200,
        codeLabel: "OK · with output=1",
        sample: `{
  "job": { /* same as above */ },
  "output": "[2026-05-07 03:21:08] starting…\\n[2026-05-07 03:48:31] done\\n",
  "outputSize": 4823917
}`,
      },
    ],
  },
  {
    id: "resync-job",
    group: "jobs",
    method: "POST",
    path: "/api/v1/jobs/:id/resync",
    navLabel: "Resync job state",
    title: "Resync job state",
    description: <>Re-queries Slurm via <code>squeue</code> then <code>sacct</code> and overwrites the DB row&apos;s status + exit code. Useful when the background watcher missed a terminal transition (bastion SSH drop mid-tail, output file on an unmounted path, etc.).</>,
    request: {
      sample: `curl -s -X POST \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/jobs/$JOB_ID/resync" | jq`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK · updated",
        sample: `{
  "updated": true,
  "previous": "RUNNING",
  "next": "COMPLETED",
  "exitCode": 0,
  "source": "sacct"
}`,
      },
      {
        code: 200,
        codeLabel: "OK · no Slurm record",
        doc: "Returned when the job has aged out of accounting and squeue doesn't know about it either.",
        sample: `{
  "updated": false,
  "previous": "RUNNING",
  "source": "sacct",
  "squeue": "",
  "sacct": "",
  "error": "Slurm returned no state — accounting unavailable or job expired from records"
}`,
      },
    ],
  },
  // ───── Provisioning ─────────────────────────────────────────────────
  {
    id: "bootstrap-cluster",
    group: "provisioning",
    method: "POST",
    path: "/api/v1/clusters/:cluster/bootstrap",
    navLabel: "Bootstrap cluster",
    title: "Bootstrap a cluster (synchronous)",
    description: (
      <>
        <p>
          Runs the same ansible playbook the UI&apos;s <b>Bootstrap</b> button drives,
          but BLOCKS until ansible exits and returns the full stdout / stderr
          in the response body. Skips the BackgroundTask + audit + controller
          auto-seed post-steps so the run is fast to iterate.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          On success the cluster&apos;s status flips to <code>ACTIVE</code> and the
          template&apos;s default <code>main</code> partition is mirrored into{" "}
          <code>cluster.config.slurm_partitions</code>.
        </p>
      </>
    ),
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
    ],
    request: {
      sample: `curl -s -X POST \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/clusters/$CLUSTER_ID/bootstrap"`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK",
        sample: `{
  "status": "success",
  "exitCode": 0,
  "durationMs": 155234,
  "clusterId": "99df89d4-…",
  "clusterName": "tm-h20",
  "stdout": "PLAY [Bootstrap master node] …\\nPLAY RECAP …",
  "stderr": ""
}`,
      },
      {
        code: 500,
        codeLabel: "Failed",
        doc: "Ansible exited non-zero. Full logs are in stdout/stderr — grep for `failed:` to find the offending task.",
        sample: `{
  "status": "failed",
  "exitCode": 2,
  "durationMs": 14210,
  "stdout": "…",
  "stderr": "ERROR! 'failed_when' is not a valid attribute for a TaskInclude"
}`,
      },
    ],
  },
  {
    id: "accounting-apply",
    group: "provisioning",
    method: "POST",
    path: "/api/v1/clusters/:cluster/accounting",
    navLabel: "Apply accounting mode",
    title: "Apply Slurm accounting mode (synchronous)",
    description: (
      <>
        <p>
          Mirrors the <b>Accounting</b> tab. Body picks the mode:
        </p>
        <ul className="mt-2 list-disc pl-5 text-sm">
          <li><code>slurmdbd</code> — install MariaDB + slurmdbd, wire <code>slurm.conf</code>, register users.</li>
          <li><code>none</code> — strip <code>AccountingStorage*</code> lines, switch to <code>accounting_storage/none</code>.</li>
          <li><code>fifo</code> — switch <code>PriorityType=priority/basic</code> (fairshare off, plain FIFO).</li>
        </ul>
      </>
    ),
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "mode", in: "body", type: "string", required: true, doc: "One of slurmdbd | none | fifo." },
    ],
    request: {
      sample: `curl -s -X POST \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"mode":"slurmdbd"}' \\
  "$AURA_BASE/api/v1/clusters/$CLUSTER_ID/accounting"`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK",
        sample: `{
  "status": "success",
  "mode": "slurmdbd",
  "durationMs": 13402,
  "clusterId": "99df89d4-…",
  "stdout": "[aura] Starting MariaDB…\\n[aura] Done. slurmdbd running, accounts created.",
  "stderr": ""
}`,
      },
    ],
  },
  {
    id: "fetch-logs",
    group: "provisioning",
    method: "GET",
    path: "/api/v1/clusters/:cluster/logs",
    navLabel: "Fetch service logs",
    title: "Fetch a service's logs from the controller",
    description: (
      <>
        Reads the last N log lines for a named Slurm/system service. Auto-branches
        on <code>cluster.config.node_supervisor</code> — runs{" "}
        <code>journalctl -u …</code> on systemd hosts, tails the per-service
        out/err files under <code>/root/.pm2-go/logs/</code> on container hosts.
      </>
    ),
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "service", in: "query", type: "string", required: true, doc: "One of: slurmctld | slurmd | slurmdbd | munge | mariadb | mysql | chrony | sssd | nfs-kernel-server | aura-agent." },
      { name: "lines", in: "query", type: "number", doc: "Default 200, clamped to [10, 5000]." },
    ],
    request: {
      sample: `curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/clusters/$CLUSTER_ID/logs?service=slurmctld&lines=200"`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK",
        sample: `{
  "clusterId": "99df89d4-…",
  "clusterName": "tm-h20",
  "service": "slurmctld",
  "supervisor": "pm2",
  "lines": 200,
  "durationMs": 482,
  "success": true,
  "output": "==> /root/.pm2-go/logs/slurmctld-err.log <==\\nslurmctld: Running as primary controller\\n…",
  "stderr": ""
}`,
      },
    ],
  },
  {
    id: "add-node",
    group: "provisioning",
    method: "POST",
    path: "/api/v1/clusters/:cluster/nodes",
    navLabel: "Add a node",
    title: "Add a worker node to a cluster",
    description: (
      <>
        Drives the same install script as the <b>Nodes → Add</b> dialog
        (slurmd + munge + key sync over SSH), then blocks until the
        underlying BackgroundTask finishes. Returns the task&apos;s full log.
      </>
    ),
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "nodeName", in: "body", type: "string", required: true, doc: "Slurm node name." },
      { name: "ip", in: "body", type: "string", required: true, doc: "Reachable IP / hostname for SSH." },
      { name: "sshUser", in: "body", type: "string", doc: "Defaults to root." },
      { name: "sshPort", in: "body", type: "number", doc: "Defaults to 22." },
      { name: "cpus", in: "body", type: "number", required: true, doc: "" },
      { name: "memoryMb", in: "body", type: "number", required: true, doc: "" },
      { name: "gpus", in: "body", type: "number", doc: "Defaults to 0." },
    ],
    request: {
      sample: `curl -s -X POST \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"nodeName":"gpu1","ip":"localhost","sshUser":"root","cpus":8,"gpus":0,"memoryMb":16384}' \\
  "$AURA_BASE/api/v1/clusters/$CLUSTER_ID/nodes"`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK",
        sample: `{
  "status": "success",
  "taskId": "…-uuid-…",
  "logs": "[1/7] Updating cluster config\\n[2/7] Copying munge key\\n…",
  "nodeName": "gpu1",
  "clusterId": "99df89d4-…"
}`,
      },
    ],
  },
  {
    id: "deploy-mount",
    group: "provisioning",
    method: "POST",
    path: "/api/v1/clusters/:cluster/storage/mounts",
    navLabel: "Deploy storage mount",
    title: "Deploy a storage mount (NFS or s3fs)",
    description: (
      <>
        Drives <code>/api/clusters/[id]/storage/deploy</code> behind the
        scenes and blocks until the underlying BackgroundTask finishes.
        Body shape mirrors the UI&apos;s Plug button — pass the full mount
        record from <code>cluster.config.storage_mounts</code>.
      </>
    ),
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "mount", in: "body", type: "StorageMount", required: true, doc: "Full mount entry: { id, type, mountPath, nfsServer?, nfsPath?, nfsServerId?, s3Bucket?, s3Endpoint?, s3AccessKey?, s3SecretKey?, s3Region? }" },
    ],
    request: {
      sample: `curl -s -X POST -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"mount":{"id":"m-1","type":"nfs","mountPath":"/mnt/shared","nfsServerId":"nfs-1"}}' \\
  "$AURA_BASE/api/v1/clusters/$CID/storage/mounts"`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK",
        sample: `{
  "kind": "task",
  "taskId": "…",
  "status": "success",
  "logs": "Setting up node1…\\nNFS mount deployed successfully!",
  "durationMs": 4831,
  "clusterId": "…"
}`,
      },
    ],
  },
  {
    id: "remove-mount",
    group: "provisioning",
    method: "DELETE",
    path: "/api/v1/clusters/:cluster/storage/mounts/:mountId",
    navLabel: "Remove storage mount",
    title: "Unmount + strip an existing storage mount",
    description: <>Unmounts on every worker, removes the <code>/etc/fstab</code> entry, deletes the s3fs credentials file. Remote data untouched.</>,
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "mountId", in: "path", type: "string", required: true, doc: "Mount entry id (from cluster.config.storage_mounts)." },
    ],
    request: {
      sample: `curl -s -X DELETE -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/clusters/$CID/storage/mounts/m-1"`,
    },
    responses: [{ code: 200, codeLabel: "OK", sample: `{ "status": "success", "logs": "…", "durationMs": 3120 }` }],
  },
  {
    id: "deploy-nfs-server",
    group: "provisioning",
    method: "POST",
    path: "/api/v1/clusters/:cluster/storage/nfs-servers",
    navLabel: "Self-host NFS server",
    title: "Provision a self-hosted NFS server on a cluster node",
    description: <>Installs <code>nfs-kernel-server</code> on the chosen node, creates the export, manages <code>/etc/exports</code>, runs <code>exportfs -ra</code>.</>,
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "server", in: "body", type: "NfsServer", required: true, doc: "{ id, hostNode, exportPath, allowedNetwork }." },
    ],
    request: {
      sample: `curl -s -X POST -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"server":{"id":"nfs-1","hostNode":"gpu1","exportPath":"/srv/aura","allowedNetwork":"*"}}' \\
  "$AURA_BASE/api/v1/clusters/$CID/storage/nfs-servers"`,
    },
    responses: [{ code: 200, codeLabel: "OK", sample: `{ "status": "success", "logs": "…", "durationMs": 2210 }` }],
  },
  {
    id: "remove-nfs-server",
    group: "provisioning",
    method: "DELETE",
    path: "/api/v1/clusters/:cluster/storage/nfs-servers/:serverId",
    navLabel: "Remove NFS server",
    title: "Strip a self-hosted NFS server's export",
    description: <>Removes the <code>/etc/exports</code> line and re-runs <code>exportfs -ra</code>. Leaves the directory + the kernel package alone.</>,
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "serverId", in: "path", type: "string", required: true, doc: "NFS server entry id (from cluster.config.nfs_servers)." },
    ],
    request: {
      sample: `curl -s -X DELETE -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/clusters/$CID/storage/nfs-servers/nfs-1"`,
    },
    responses: [{ code: 200, codeLabel: "OK", sample: `{ "status": "success", "logs": "…", "durationMs": 1340 }` }],
  },
  {
    id: "install-packages",
    group: "provisioning",
    method: "POST",
    path: "/api/v1/clusters/:cluster/packages",
    navLabel: "Install apt packages",
    title: "Install apt packages on every cluster node",
    description: <>Runs <code>apt-get install -y</code> on every host. Package list is also persisted to <code>cluster.config.installed_packages</code> so re-bootstrap is idempotent.</>,
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "packages", in: "body", type: "string[]", required: true, doc: "Apt package names. Versions allowed (e.g. \"htop=3.2.2-1\")." },
    ],
    request: {
      sample: `curl -s -X POST -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"packages":["htop","jq","curl"]}' \\
  "$AURA_BASE/api/v1/clusters/$CID/packages"`,
    },
    responses: [{ code: 200, codeLabel: "OK", sample: `{ "status": "success", "logs": "…", "durationMs": 18922 }` }],
  },
  {
    id: "install-python-packages",
    group: "provisioning",
    method: "POST",
    path: "/api/v1/clusters/:cluster/python-packages",
    navLabel: "Install Python packages",
    title: "Install Python packages into the cluster venv",
    description: (
      <>
        <p>
          Two-step: persists the package list + install mode into{" "}
          <code>cluster.config</code>, then runs the apply (uv-based pip)
          on each target. Blocks until install finishes. Use{" "}
          <code>installMode: &quot;per-node&quot;</code> when the venv must
          be local to each node (typical for CUDA wheels); the default{" "}
          <code>shared</code> writes one venv on the shared mount.
        </p>
      </>
    ),
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "packages", in: "body", type: "Array<{name,indexUrl?,extraIndexUrl?}>", required: true, doc: "Package specs (e.g. {\"name\":\"vllm==0.19.1\"})." },
      { name: "installMode", in: "body", type: "\"shared\" | \"per-node\"", doc: "Default \"shared\"." },
      { name: "localVenvPath", in: "body", type: "string", doc: "per-node venv path. Default /opt/aura-venv." },
      { name: "venvLocation", in: "body", type: "string", doc: "Shared-mode parent dir (e.g. /mnt/shared/aura)." },
      { name: "pythonVersion", in: "body", type: "string", doc: "Default 3.12." },
    ],
    request: {
      sample: `curl -s -X POST -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "packages": [{"name":"vllm==0.19.1"}],
    "installMode": "per-node",
    "localVenvPath": "/opt/aura-venv",
    "pythonVersion": "3.12"
  }' \\
  "$AURA_BASE/api/v1/clusters/$CID/python-packages"`,
    },
    responses: [{ code: 200, codeLabel: "OK", sample: `{ "status": "success", "logs": "…uv pip install vllm==0.19.1…", "durationMs": 412332 }` }],
  },
  {
    id: "provision-user",
    group: "provisioning",
    method: "POST",
    path: "/api/v1/clusters/:cluster/users",
    navLabel: "Provision a user",
    title: "Provision an Aura user to the cluster",
    description: <>Creates the Linux account on every node, syncs the munge key, returns the unix UID. The cluster must be <code>ACTIVE</code>.</>,
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "userId", in: "body", type: "string", required: true, doc: "Aura user UUID." },
    ],
    request: {
      sample: `curl -s -X POST -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"userId":"<aura-user-uuid>"}' \\
  "$AURA_BASE/api/v1/clusters/$CID/users"`,
    },
    responses: [{ code: 200, codeLabel: "OK", sample: `{ "ok": true, "unixUsername": "alice", "unixUid": 10001 }` }],
  },
  {
    id: "install-metrics",
    group: "provisioning",
    method: "POST",
    path: "/api/v1/clusters/:cluster/metrics/install",
    navLabel: "Install metrics stack",
    title: "Install node_exporter + nvidia_gpu_exporter + promtail",
    description: <>Installs the Prometheus scrape agents on every node and points Prometheus at them. Optionally scope to a subset via <code>hostnames</code>.</>,
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "hostnames", in: "body", type: "string[]", doc: "Optional list of node hostnames to scope to." },
    ],
    request: {
      sample: `curl -s -X POST -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" -d '{}' \\
  "$AURA_BASE/api/v1/clusters/$CID/metrics/install"`,
    },
    responses: [{ code: 200, codeLabel: "OK", sample: `{ "ok": true, "scraped": 1, "log": "…" }` }],
  },
  {
    id: "deploy-metrics-stack",
    group: "provisioning",
    method: "POST",
    path: "/api/v1/clusters/:cluster/metrics/stack",
    navLabel: "Deploy Prometheus + Grafana",
    title: "Deploy the Prometheus + Grafana (+ optional Loki) stack",
    description: (
      <>
        Installs Prometheus, Grafana (and Loki when{" "}
        <code>metrics.lokiEnabled</code>) on the cluster&apos;s stack host
        (defaults to the controller). Supervisor-aware: VM/bare-metal
        hosts use systemd, containers fall through to pm2-go (the same
        supervisor the bootstrap installs). Auto-generates a Grafana
        admin password and persists it on the cluster config.
      </>
    ),
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
    ],
    request: {
      sample: `curl -s -X POST -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/clusters/$CID/metrics/stack"`,
    },
    responses: [
      { code: 200, codeLabel: "OK", sample: `{
  "kind": "task",
  "taskId": "…",
  "status": "success",
  "logs": "…",
  "durationMs": 248123,
  "clusterId": "…"
}` },
    ],
  },
  {
    id: "remove-metrics-stack",
    group: "provisioning",
    method: "DELETE",
    path: "/api/v1/clusters/:cluster/metrics/stack",
    navLabel: "Remove Prometheus + Grafana",
    title: "Tear down the metrics stack",
    description: (
      <>
        Stops and removes Prometheus / Grafana / Loki on the stack host
        (via whichever supervisor the deploy used) and clears the
        persisted Grafana password from the cluster config.
      </>
    ),
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
    ],
    request: {
      sample: `curl -s -X DELETE \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/clusters/$CID/metrics/stack"`,
    },
    responses: [
      { code: 200, codeLabel: "OK", sample: `{ "kind":"task","taskId":"…","status":"success","logs":"…","durationMs":12345,"clusterId":"…" }` },
    ],
  },
  {
    id: "delete-node",
    group: "provisioning",
    method: "DELETE",
    path: "/api/v1/clusters/:cluster/nodes/:nodeName",
    navLabel: "Delete a node",
    title: "Delete a node from a cluster",
    description: (
      <>
        Removes the node from <code>cluster.config</code> and from{" "}
        <code>slurm.conf</code>, then restarts slurmctld + slurmd via the
        host&apos;s configured supervisor (systemd or pm2-go).
      </>
    ),
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "nodeName", in: "path", type: "string", required: true, doc: "Slurm node name to remove." },
    ],
    request: {
      sample: `curl -s -X DELETE \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/clusters/$CLUSTER_ID/nodes/gpu1"`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK",
        sample: `{
  "ok": true,
  "nodeName": "gpu1",
  "log": "[1/3] Removed gpu1 from cluster config\\n[2/3] Removing gpu1 from slurm.conf\\n  slurm.conf updated\\n  cleared cached slurmctld state\\n  slurmctld restarted\\n  slurmd restarted\\n[3/3] Done."
}`,
      },
    ],
  },
  {
    id: "exec",
    group: "provisioning",
    method: "POST",
    path: "/api/v1/clusters/:cluster/exec",
    navLabel: "Run a shell command",
    title: "Run an arbitrary shell command on the controller",
    description: (
      <>
        SSHes into the cluster&apos;s controller and runs <code>command</code>{" "}
        verbatim. Useful for probing state during iteration — for example{" "}
        <code>stat -c %U:%G:%a /var/lib/munge</code> or{" "}
        <code>scontrol show node</code>. Admin only.
      </>
    ),
    parameters: [
      { name: "cluster", in: "path", type: "string", required: true, doc: "Cluster UUID." },
      { name: "command", in: "body", type: "string", required: true, doc: "Bash command to run as the cluster's SSH user." },
    ],
    request: {
      sample: `curl -s -X POST \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"command":"scontrol show node"}' \\
  "$AURA_BASE/api/v1/clusters/$CLUSTER_ID/exec"`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK",
        sample: `{
  "clusterId": "99df89d4-…",
  "command": "scontrol show node",
  "success": true,
  "exitCode": 0,
  "stdout": "NodeName=gpu1 Arch=x86_64 …",
  "stderr": "",
  "durationMs": 312
}`,
      },
    ],
  },
  {
    id: "cancel-job",
    group: "jobs",
    method: "POST",
    path: "/api/v1/jobs/:id/cancel",
    navLabel: "Cancel a job",
    title: "Cancel a job",
    description: <>Runs <code>scancel --signal=KILL --full</code> on the controller (with a sudo fallback) and flips the DB row to <code>CANCELLED</code>. Safe to call on already-terminal jobs.</>,
    request: {
      sample: `curl -s -X POST \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/jobs/$JOB_ID/cancel" | jq`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK",
        sample: `{
  "id": "9f1d83c4-9a2e-4711-9b3f-37b5b3cd2e1c",
  "slurmJobId": 184,
  "status": "CANCELLED"
}`,
      },
    ],
  },
  {
    id: "trim-job-output",
    group: "admin",
    method: "POST",
    path: "/api/v1/admin/maintenance/truncate-job-output",
    navLabel: "Trim cached job logs",
    title: "Trim cached job logs",
    description: (
      <>
        <p>
          <b>Admin only.</b> Shrinks every <code>Job.output</code> row to the last 256 KB
          and runs <code>VACUUM (ANALYZE) &quot;Job&quot;</code> to reclaim TOAST space.
          Use after a noisy job (vLLM debug logs, etc.) has bloated the column, or after
          upgrading from a build whose watcher didn&apos;t cap captured output.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Idempotent — rows already at or under the cap are left alone.
        </p>
      </>
    ),
    request: {
      sample: `curl -s -X POST \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  "$AURA_BASE/api/v1/admin/maintenance/truncate-job-output" | jq`,
    },
    responses: [
      {
        code: 200,
        codeLabel: "OK",
        sample: `{
  "ok": true,
  "capBytes": 262144,
  "rowsTrimmed": 9,
  "vacuumed": true,
  "before": {
    "oversizedRows": 9,
    "totalBytes": 77675765,
    "largestRowBytes": 53074459,
    "avgRowBytes": 1726128
  },
  "after": {
    "oversizedRows": 0,
    "totalBytes": 2731695,
    "largestRowBytes": 262144,
    "avgRowBytes": 60704
  }
}`,
      },
      {
        code: 403,
        codeLabel: "Forbidden",
        doc: "Returned for non-admin tokens.",
        sample: `{ "error": "Forbidden — admin only" }`,
      },
    ],
  },
];

const ERROR_TABLE: Array<{ code: string; meaning: string }> = [
  { code: "401 Unauthorized", meaning: "Missing / revoked / wrong token." },
  { code: "403 Forbidden", meaning: "VIEWER trying to submit, non-admin reading someone else's job, or non-admin hitting an admin route." },
  { code: "404 Not Found", meaning: "Cluster name/id unknown, or job id doesn't exist." },
  { code: "400 Bad Request", meaning: "Missing `script`, missing `partition` (and no default on the cluster), or invalid JSON." },
  { code: "502 Bad Gateway", meaning: "Submit reached the cluster but `sbatch` errored, or a name collision against a RUNNING job. Body carries the upstream message." },
];

export default function ApiDocsPage() {
  const [host, setHost] = useState<string>("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") setHost(window.location.origin);
  }, []);

  const base = host || "https://slurmui.example.com";
  const sub = (s: string) => s.split("$AURA_BASE").join(base);

  // Filter endpoints by query (matches navLabel, path, method).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ENDPOINTS;
    return ENDPOINTS.filter((e) =>
      e.navLabel.toLowerCase().includes(q) ||
      e.path.toLowerCase().includes(q) ||
      e.method.toLowerCase().includes(q),
    );
  }, [query]);

  // Group endpoints for the sidebar + main content.
  const grouped = useMemo(() => {
    const out: Array<{ group: Group; items: Endpoint[] }> = [];
    for (const g of GROUPS) {
      const items = filtered.filter((e) => e.group === g.id);
      if (items.length > 0) out.push({ group: g, items });
    }
    return out;
  }, [filtered]);

  return (
    // -m-6 cancels the (user) layout's `<main className="p-6">` padding
    // so this page can manage its own gutters. Without it, the layout's
    // 24 px frame combines with column padding and the sidebar/title
    // alignment becomes finicky.
    <div className="-m-6 grid min-h-[calc(100vh-3.5rem)] grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)]">
      {/* Endpoint nav — plain <div>, same wrapper shape as the main
          column on the right. Both grid cells start at row 1, same Y. */}
      <div className="hidden border-r lg:block">
        {/* `top-0` (not `top-14`) — the layout's scrolling container
            (`<main className="overflow-auto p-6">` in the user layout)
            is what sticky measures against, and its top edge is already
            below the fixed app header. With `top-14` the sticky div was
            firing immediately on render: its natural Y in the scroll
            container is 0, the threshold was 56 px, 0 < 56 so the
            browser pushes it down to the threshold even before scroll.
            That 56 px shove is exactly why the search bar appeared
            below the title. `top-0` only sticks once the element would
            actually scroll above the container top. */}
        <div className="sticky top-0 max-h-[calc(100vh-3.5rem)] overflow-y-auto px-3 pb-6">
          {/* h-9 search box, identical wrapper shape as the title row in
              the right column. Both rows are flex h-9 items-center, both
              start at pt-6 from the same grid row. Search input and
              title sit in boxes at the exact same Y. */}
          <div className="relative flex h-9 items-center">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search endpoints…"
              className="h-9 pl-8 text-xs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="h-3" />{/* mb-3 → explicit spacer keeps row 1
              identical on both sides; no margin-collapse surprises. */}
          <nav className="space-y-2.5 text-sm">
            <a href="#auth" className="block px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground/80 hover:text-foreground">
              Authentication
            </a>
            {grouped.map(({ group, items }) => (
              <div key={group.id} className="space-y-px">
                <a
                  href={`#${group.id}`}
                  className="block px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground/80"
                >
                  {group.title}
                </a>
                <ul>
                  {items.map((e) => (
                    <li key={e.id}>
                      <a
                        href={`#${e.id}`}
                        className="flex items-center gap-1.5 rounded px-2 py-0.5 hover:bg-muted"
                      >
                        <MethodBadge method={e.method} size="xs" />
                        <span className="truncate font-mono text-[11px] text-muted-foreground">{e.path}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <a href="#errors" className="block px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground/80 hover:text-foreground">
              Errors
            </a>
            <a href="#quickstart" className="block px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground/80 hover:text-foreground">
              Quick-start
            </a>
          </nav>
        </div>
      </div>

      {/* Main content — same shape as the left column: plain <div>, with
          the same pt-6 / px-6 inside. Both grid cells share row 1. */}
      <div className="min-w-0 px-6 pt-6 pb-10">
        {/* Title row mirrors the sidebar's search row: both start at
            pt-6 from the flex container top, both are 36 px tall (h-9),
            both centre-align their content. Title text and search input
            now sit in boxes at the exact same Y. */}
        <header className="space-y-4 pb-6">
          <div className="flex h-9 items-center justify-between gap-4">
            <h1 className="text-2xl font-semibold leading-none tracking-tight">
              HTTP API
            </h1>
            <Button asChild size="sm">
              <Link href="/profile/api-tokens">
                <KeyRound className="mr-2 h-4 w-4" /> Manage tokens
              </Link>
            </Button>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Programmatic Slurm job submission &amp; inspection. All endpoints are rooted
            under <code>/api/v1</code>. Browser sessions are also accepted, so the same
            routes back internal UI without a second auth path.
          </p>

          <div className="grid gap-3 md:grid-cols-3">
            <InfoCard label="Base URL" body={base} />
            <InfoCard label="Authentication header" body="Authorization: Bearer aura_xxxxxxxxxxxx" />
            <InfoCard
              label="Quick start"
              body={`# 1. mint a token
open ${base}/profile/api-tokens

# 2. who am I?
curl -H "Authorization: Bearer $AURA_TOKEN" \\
  ${base}/api/v1/clusters`}
              wide
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Create a token at{" "}
            <Link href="/profile/api-tokens" className="underline">My Profile → API Tokens</Link>.
            Tokens inherit the role of the user that minted them — <code>ADMIN</code> can
            submit and read across clusters; <code>VIEWER</code> is read-only and limited
            to its own jobs.
          </p>
        </header>

        <section id="auth" className="space-y-2 scroll-mt-20 border-t pt-5">
          <h2 className="text-lg font-semibold tracking-tight">Authentication</h2>
          <p className="text-sm text-muted-foreground">
            Send <code>Authorization: Bearer &lt;token&gt;</code> on every request.
            Browser sessions (the cookie set by <code>/login</code>) are also accepted in
            place of the Bearer token, so the same endpoints work from your own UI without
            extra plumbing.
          </p>
        </section>

        {grouped.map(({ group, items }) => (
          <div key={group.id}>
            <section id={group.id} className="scroll-mt-20 border-t pt-5">
              <h2 className="text-lg font-semibold tracking-tight">{group.title}</h2>
              {group.blurb && <p className="mt-0.5 text-sm text-muted-foreground">{group.blurb}</p>}
            </section>
            {items.map((e) => (
              <EndpointSection key={e.id} endpoint={e} sub={sub} />
            ))}
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="border-t py-12 text-center text-sm text-muted-foreground">
            No endpoints match <code>&quot;{query}&quot;</code>.
          </div>
        )}

        <section id="errors" className="space-y-3 scroll-mt-20 border-t pt-5 mt-8">
          <h2 className="text-xl font-semibold tracking-tight">Errors</h2>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Code</th>
                  <th className="px-3 py-2 text-left font-medium">Meaning</th>
                </tr>
              </thead>
              <tbody>
                {ERROR_TABLE.map((row) => (
                  <tr key={row.code} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{row.code}</td>
                    <td className="px-3 py-2 text-xs">{row.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="quickstart" className="space-y-3 scroll-mt-20 border-t pt-5 mt-8">
          <h2 className="text-xl font-semibold tracking-tight">Quick-start: poll until done</h2>
          <p className="text-sm text-muted-foreground">
            End-to-end smoke test. Submits a tiny job, polls for completion, fetches the
            last 1 MB of stdout.
          </p>
          <CodeBlock label="Bash">{sub(`AURA_TOKEN="aura_xxxxxxxxxxxxxxxxxxxxxxxxxx"
BASE="$AURA_BASE/api/v1"

# submit
RES=$(curl -s -X POST "$BASE/clusters/my-cluster/jobs" \\
  -H "Authorization: Bearer $AURA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"demo","script":"#!/bin/bash\\nhostname\\ndate"}')
JOB_ID=$(echo "$RES" | jq -r .id)
echo "submitted $JOB_ID"

# poll until terminal
while true; do
  STATUS=$(curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
    "$BASE/jobs/$JOB_ID" | jq -r .job.status)
  echo "status=$STATUS"
  case "$STATUS" in COMPLETED|FAILED|CANCELLED) break;; esac
  sleep 5
done

# tail output
curl -s -H "Authorization: Bearer $AURA_TOKEN" \\
  "$BASE/jobs/$JOB_ID?output=1" | jq -r .output`)}</CodeBlock>
        </section>
      </div>
    </div>
  );
}

function InfoCard({ label, body, wide = false }: { label: string; body: string; wide?: boolean }) {
  return (
    <div className={"relative rounded-md border bg-muted/30 p-3 " + (wide ? "md:col-span-1" : "")}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-foreground/90">
        {body}
      </pre>
      <CopyBtn text={body} />
    </div>
  );
}

function EndpointSection({ endpoint: e, sub }: { endpoint: Endpoint; sub: (s: string) => string }) {
  return (
    <section
      id={e.id}
      className="scroll-mt-20 border-t py-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]"
    >
      {/* Left column: docs */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <MethodBadge method={e.method} />
          <code className="font-mono text-sm">{e.path}</code>
        </div>
        <h3 className="text-base font-semibold tracking-tight">{e.title}</h3>
        <div className="prose-sm max-w-none text-sm">{e.description}</div>

        {e.parameters && e.parameters.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Parameters
            </h4>
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-2.5 py-1.5 text-left text-xs font-medium">Name</th>
                    <th className="px-2.5 py-1.5 text-left text-xs font-medium">In</th>
                    <th className="px-2.5 py-1.5 text-left text-xs font-medium">Type</th>
                    <th className="px-2.5 py-1.5 text-left text-xs font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {e.parameters.map((p) => (
                    <tr key={`${p.in}:${p.name}`} className="border-t align-top">
                      <td className="px-2.5 py-1.5 font-mono text-xs">
                        {p.name}
                        {p.required && <span className="ml-1 text-rose-600">*</span>}
                      </td>
                      <td className="px-2.5 py-1.5 text-xs text-muted-foreground">{p.in}</td>
                      <td className="px-2.5 py-1.5 font-mono text-xs text-muted-foreground">{p.type}</td>
                      <td className="px-2.5 py-1.5 text-xs">{p.doc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Right column: request + response samples */}
      <div className="space-y-3 lg:sticky lg:top-16 lg:self-start lg:max-h-[calc(100vh-5rem)] lg:overflow-y-auto">
        <div>
          <CodeBlock label="Request">{sub(e.request.sample)}</CodeBlock>
        </div>
        <div className="space-y-2.5">
          {e.responses.map((r, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <StatusBadge code={r.code} label={r.codeLabel} />
              </div>
              {r.doc && <p className="text-xs text-muted-foreground">{r.doc}</p>}
              <CodeBlock label="Response">{r.sample}</CodeBlock>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
