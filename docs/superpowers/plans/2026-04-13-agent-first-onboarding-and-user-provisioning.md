# Agent-First Cluster Onboarding & User Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Ansible-from-web bootstrap with an agent-first flow where the admin runs a one-liner on the master node, then completes cluster config through a guided UI using the live agent. Add agent-based Linux user provisioning with globally consistent UIDs.

**Architecture:** Phase 1 installs the agent via a token-gated bash script served by the web app; heartbeat detection via NATS SSE confirms connection. Phase 2 is a guided stepper on the cluster detail page that sends new agent commands (`test_nfs`, `setup_nodes`, `setup_partitions`) running Ansible from the master. User provisioning sends `provision_user` to the master agent which creates the Linux account locally and replicates to workers via Ansible.

**Tech Stack:** Next.js 14 App Router, Prisma, NATS JetStream, Go agent, Ansible, shadcn/ui

---

## File Map

**Create:**
- `web/app/api/install/[token]/route.ts` — serve bash install script
- `web/app/api/install/[token]/binary/route.ts` — serve agent binary (token-gated)
- `web/app/api/clusters/[id]/install-token/route.ts` — regenerate install token
- `web/app/api/clusters/[id]/heartbeat/stream/route.ts` — SSE heartbeat detection
- `web/app/api/clusters/[id]/setup/nfs/route.ts` — Phase 2 NFS step
- `web/app/api/clusters/[id]/setup/nodes/route.ts` — Phase 2 nodes step
- `web/app/api/clusters/[id]/setup/partitions/route.ts` — Phase 2 partitions step
- `web/app/api/clusters/[id]/setup/health/route.ts` — Phase 2 health check step
- `web/app/api/clusters/[id]/users/route.ts` — list + provision users
- `web/app/api/clusters/[id]/users/[userId]/route.ts` — update ClusterUser status
- `web/components/wizard/step-install.tsx` — install command + heartbeat wait UI
- `web/components/cluster/setup-stepper.tsx` — Phase 2 guided setup (client)
- `web/components/cluster/users-tab.tsx` — users tab (client)
- `agent/internal/handler/setup_handler.go` — test_nfs, setup_nodes, setup_partitions
- `agent/internal/handler/user_handler.go` — provision_user
- `ansible/setup_nfs.yml`
- `ansible/setup_nodes.yml`
- `ansible/setup_partitions.yml`
- `ansible/user_provision.yml`
- `ansible/roles/aura_user/tasks/main.yml`
- `ansible/roles/aura_user/defaults/main.yml`

**Modify:**
- `web/prisma/schema.prisma` — add install token fields, unixUid/unixGid, ClusterUser
- `web/app/api/clusters/route.ts` — generate token on POST
- `web/app/(admin)/admin/clusters/new/page.tsx` — reduce to 2 steps
- `web/components/wizard/step-basics.tsx` — remove IP/SSH/FreeIPA fields
- `web/app/(admin)/admin/clusters/[id]/page.tsx` — add SetupStepper + Users tab
- `agent/internal/message/message.go` — 4 new command types + payloads
- `agent/internal/handler/dispatcher.go` — register setup + user handlers

---

## Milestone 1 — Phase 1: Install Script & Heartbeat Detection

---

### Task 1: Prisma schema — install token fields

**Files:**
- Modify: `web/prisma/schema.prisma`

- [ ] **Step 1: Add install token fields to Cluster model**

In `web/prisma/schema.prisma`, add three fields to the `Cluster` model after `updatedAt`:

```prisma
model Cluster {
  id              String        @id @default(uuid())
  name            String        @unique
  controllerHost  String
  natsCredentials String
  status          ClusterStatus @default(PROVISIONING)
  config          Json
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  jobs            Job[]

  installToken          String?   @unique
  installTokenExpiresAt DateTime?
  installTokenUsedAt    DateTime?
  clusterUsers          ClusterUser[]
}
```

Also add the `ClusterUser` model and `ClusterUserStatus` enum after the `UserRole` enum:

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
  @@index([clusterId])
}

enum ClusterUserStatus {
  PENDING
  ACTIVE
  FAILED
}
```

Update `User` model — rename `freeipaUid`/`freeipaGid` and add relation:

```prisma
model User {
  id         String        @id @default(uuid())
  keycloakId String        @unique
  email      String        @unique
  name       String?
  unixUid    Int?          @unique
  unixGid    Int?
  role       UserRole      @default(USER)
  createdAt  DateTime      @default(now())
  clusters   ClusterUser[]
}
```

- [ ] **Step 2: Create and run migration**

```bash
cd web
npx prisma migrate dev --name add_install_token_and_cluster_user
```

Expected: migration file created in `web/prisma/migrations/`, Prisma client regenerated.

- [ ] **Step 3: Commit**

```bash
git add web/prisma/schema.prisma web/prisma/migrations/
git commit -m "feat(db): add install token fields, ClusterUser model, rename freeipaUid to unixUid"
```

---

### Task 2: POST /api/clusters — generate install token on creation

**Files:**
- Modify: `web/app/api/clusters/route.ts`

- [ ] **Step 1: Add token generation to cluster creation**

Replace the entire file:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clusters = await prisma.cluster.findMany({
    select: {
      id: true,
      name: true,
      controllerHost: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { jobs: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(clusters);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { name, controllerHost } = body;
  if (!name || !controllerHost) {
    return NextResponse.json(
      { error: "Missing required fields: name, controllerHost" },
      { status: 400 }
    );
  }

  const existing = await prisma.cluster.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json(
      { error: `Cluster with name "${name}" already exists` },
      { status: 409 }
    );
  }

  const installToken = randomUUID();
  const installTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  const cluster = await prisma.cluster.create({
    data: {
      name,
      controllerHost,
      natsCredentials: "",
      status: "PROVISIONING",
      config: { slurm_cluster_name: name, slurm_controller_host: controllerHost },
      installToken,
      installTokenExpiresAt,
    },
  });

  return NextResponse.json(cluster, { status: 201 });
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/api/clusters/route.ts
git commit -m "feat(api): generate install token on cluster creation"
```

---

### Task 3: Install script + binary endpoints

**Files:**
- Create: `web/app/api/install/[token]/route.ts`
- Create: `web/app/api/install/[token]/binary/route.ts`

- [ ] **Step 1: Create install script endpoint**

Create `web/app/api/install/[token]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface RouteParams {
  params: Promise<{ token: string }>;
}

async function validateToken(token: string) {
  const cluster = await prisma.cluster.findUnique({
    where: { installToken: token },
  });
  if (!cluster) return { error: "Invalid token", status: 404 };
  if (cluster.installTokenUsedAt) return { error: "Token already used", status: 410 };
  if (cluster.installTokenExpiresAt && cluster.installTokenExpiresAt < new Date()) {
    return { error: "Token expired", status: 410 };
  }
  return { cluster };
}

// GET /api/install/[token] — serve bash install script (no auth, token IS the credential)
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { token } = await params;
  const result = await validateToken(token);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const { cluster } = result;
  const baseUrl = process.env.NEXTAUTH_URL ?? "https://aura.aies.scicom.dev";
  const natsUrl = process.env.NEXT_PUBLIC_NATS_URL ?? "nats://nats.aura.aies.scicom.dev:4222";

  const script = `#!/bin/bash
set -euo pipefail

CLUSTER_ID="${cluster.id}"
NATS_URL="${natsUrl}"
AURA_URL="${baseUrl}"
TOKEN="${token}"

echo "[aura] Installing aura-agent for cluster: ${cluster.name}"
echo "[aura] CLUSTER_ID: $CLUSTER_ID"

# Download agent binary
echo "[aura] Downloading agent binary..."
curl -fsSL "$AURA_URL/api/install/$TOKEN/binary" -o /usr/local/bin/aura-agent
chmod +x /usr/local/bin/aura-agent
echo "[aura] Binary installed at /usr/local/bin/aura-agent"

# Write environment file
mkdir -p /etc/aura-agent
cat > /etc/aura-agent/agent.env <<EOF
CLUSTER_ID=$CLUSTER_ID
NATS_URL=$NATS_URL
SLURM_USER=slurm
ANSIBLE_PLAYBOOK_DIR=/opt/aura/ansible
EOF
echo "[aura] Environment written to /etc/aura-agent/agent.env"

# Create systemd unit
cat > /etc/systemd/system/aura-agent.service <<EOF
[Unit]
Description=Aura HPC Agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/aura-agent/agent.env
ExecStart=/usr/local/bin/aura-agent
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable aura-agent
systemctl start aura-agent
echo "[aura] aura-agent service started"
echo "[aura] Done. The agent will connect to NATS and appear in Aura shortly."
`;

  return new Response(script, {
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    },
  });
}
```

- [ ] **Step 2: Create binary download endpoint**

Create `web/app/api/install/[token]/binary/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createReadStream, statSync } from "fs";

interface RouteParams {
  params: Promise<{ token: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { token } = await params;

  const cluster = await prisma.cluster.findUnique({
    where: { installToken: token },
  });
  if (!cluster) return NextResponse.json({ error: "Invalid token" }, { status: 404 });
  if (cluster.installTokenUsedAt) return NextResponse.json({ error: "Token already used" }, { status: 410 });
  if (cluster.installTokenExpiresAt && cluster.installTokenExpiresAt < new Date()) {
    return NextResponse.json({ error: "Token expired" }, { status: 410 });
  }

  const binaryPath = process.env.AURA_AGENT_BINARY_SRC;
  if (!binaryPath) {
    return NextResponse.json({ error: "Agent binary not configured (AURA_AGENT_BINARY_SRC)" }, { status: 503 });
  }

  let stat;
  try {
    stat = statSync(binaryPath);
  } catch {
    return NextResponse.json({ error: "Agent binary not found on server" }, { status: 503 });
  }

  const nodeStream = createReadStream(binaryPath);
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => controller.enqueue(chunk));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new Response(webStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": "attachment; filename=aura-agent",
      "Cache-Control": "no-store",
    },
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/install/
git commit -m "feat(api): add install script and binary download endpoints"
```

---

### Task 4: Install token regeneration + heartbeat SSE

**Files:**
- Create: `web/app/api/clusters/[id]/install-token/route.ts`
- Create: `web/app/api/clusters/[id]/heartbeat/stream/route.ts`

- [ ] **Step 1: Token regeneration endpoint**

Create `web/app/api/clusters/[id]/install-token/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/install-token — regenerate install token (admin only)
export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const installToken = randomUUID();
  const installTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);

  const updated = await prisma.cluster.update({
    where: { id },
    data: { installToken, installTokenExpiresAt, installTokenUsedAt: null },
  });

  return NextResponse.json({ installToken: updated.installToken, installTokenExpiresAt: updated.installTokenExpiresAt });
}
```

- [ ] **Step 2: Heartbeat SSE endpoint**

Create `web/app/api/clusters/[id]/heartbeat/stream/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { subscribeHeartbeat } from "@/lib/nats";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/clusters/[id]/heartbeat/stream — SSE that fires once when agent connects
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };

      // Keep-alive ping every 20s so nginx doesn't close the connection
      const ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          clearInterval(ping);
        }
      }, 20_000);

      // Timeout after 90 minutes
      const timeout = setTimeout(() => {
        clearInterval(ping);
        send({ type: "timeout" });
        try { controller.close(); } catch {}
      }, 90 * 60 * 1000);

      try {
        const sub = await subscribeHeartbeat(id);
        for await (const _msg of sub) {
          clearTimeout(timeout);
          clearInterval(ping);

          // Mark token used
          await prisma.cluster.update({
            where: { id },
            data: { installTokenUsedAt: new Date() },
          });

          send({ type: "connected" });
          try { controller.close(); } catch {}
          sub.unsubscribe();
          return;
        }
      } catch (err) {
        clearTimeout(timeout);
        clearInterval(ping);
        send({ type: "error", message: err instanceof Error ? err.message : "NATS error" });
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/clusters/
git commit -m "feat(api): add install token regeneration and heartbeat SSE endpoints"
```

---

### Task 5: Rework wizard to 2 steps + StepInstall component

**Files:**
- Modify: `web/components/wizard/step-basics.tsx`
- Create: `web/components/wizard/step-install.tsx`
- Modify: `web/app/(admin)/admin/clusters/new/page.tsx`

- [ ] **Step 1: Simplify StepBasics — name + hostname only**

Replace `web/components/wizard/step-basics.tsx`:

```typescript
"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface StepBasicsProps {
  data: {
    clusterName: string;
    controllerHost: string;
  };
  onChange: (data: StepBasicsProps["data"]) => void;
}

export function StepBasics({ data, onChange }: StepBasicsProps) {
  const update = (field: keyof StepBasicsProps["data"], value: string) => {
    onChange({ ...data, [field]: value });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="clusterName">Cluster Name</Label>
        <Input
          id="clusterName"
          placeholder="sci-cluster-01"
          value={data.clusterName}
          onChange={(e) => update("clusterName", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Unique identifier. Lowercase and hyphens only.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="controllerHost">Controller Hostname</Label>
        <Input
          id="controllerHost"
          placeholder="slm-master"
          value={data.controllerHost}
          onChange={(e) => update("controllerHost", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          The hostname of the master/controller node. Must be resolvable from other nodes.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create StepInstall component**

Create `web/components/wizard/step-install.tsx`:

```typescript
"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check, Copy, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

interface StepInstallProps {
  clusterId: string | null;
}

type ConnState = "waiting" | "connecting" | "connected" | "timeout" | "error";

export function StepInstall({ clusterId }: StepInstallProps) {
  const [connState, setConnState] = useState<ConnState>("waiting");
  const [copied, setCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const startedRef = useRef(false);
  const router = useRouter();

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const installUrl = clusterId ? `${baseUrl}/api/install/...` : "";
  const curlCmd = clusterId
    ? `curl -fsSL ${baseUrl}/api/install/[token] | bash`
    : "Create cluster first...";

  // Fetch the actual token from the cluster record to build real URL
  const [installCmd, setInstallCmd] = useState<string | null>(null);

  useEffect(() => {
    if (!clusterId) return;
    fetch(`/api/clusters/${clusterId}`)
      .then((r) => r.json())
      .then((c) => {
        if (c.installToken) {
          setInstallCmd(`curl -fsSL ${baseUrl}/api/install/${c.installToken} | bash`);
        }
      })
      .catch(() => {});
  }, [clusterId, baseUrl]);

  useEffect(() => {
    if (!clusterId || startedRef.current) return;
    startedRef.current = true;
    setConnState("connecting");

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/clusters/${clusterId}/heartbeat/stream`);
        if (!res.ok || !res.body) {
          setConnState("error");
          setErrorMsg("Failed to open heartbeat stream");
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "connected") {
                setConnState("connected");
                return;
              } else if (event.type === "timeout") {
                setConnState("timeout");
                return;
              } else if (event.type === "error") {
                setConnState("error");
                setErrorMsg(event.message ?? "Unknown error");
                return;
              }
            } catch {}
          }
        }
      } catch (err) {
        if (!cancelled) {
          setConnState("error");
          setErrorMsg(err instanceof Error ? err.message : "Unknown error");
        }
      }
    })();

    return () => { cancelled = true; };
  }, [clusterId]);

  const copyCmd = () => {
    if (!installCmd) return;
    navigator.clipboard.writeText(installCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Run the following command on your master node as <strong>root</strong>. It will download
          the agent binary, configure it with this cluster&apos;s ID, and start it as a systemd
          service.
        </p>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center justify-between gap-2">
            <code className="flex-1 rounded bg-muted px-3 py-2 font-mono text-sm break-all">
              {installCmd ?? "Loading..."}
            </code>
            <Button variant="outline" size="sm" onClick={copyCmd} disabled={!installCmd}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        {connState === "connecting" && (
          <>
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Waiting for agent to connect...</span>
          </>
        )}
        {connState === "connected" && (
          <>
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              Agent connected
            </Badge>
            <Button onClick={() => router.push(`/admin/clusters/${clusterId}`)}>
              Continue to cluster setup →
            </Button>
          </>
        )}
        {connState === "timeout" && (
          <Badge variant="outline" className="text-yellow-700">
            Timed out — regenerate the install command from the cluster page and try again
          </Badge>
        )}
        {connState === "error" && (
          <Badge variant="destructive">Error: {errorMsg}</Badge>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Rework wizard page to 2 steps**

Replace `web/app/(admin)/admin/clusters/new/page.tsx`:

```typescript
"use client";

import { useState } from "react";
import { WizardShell } from "@/components/wizard/wizard-shell";
import { StepBasics } from "@/components/wizard/step-basics";
import { StepInstall } from "@/components/wizard/step-install";

const steps = [
  { title: "Basics", description: "Cluster name and controller hostname" },
  { title: "Install Agent", description: "Run the one-liner on your master node" },
];

export default function NewClusterPage() {
  const [basics, setBasics] = useState({ clusterName: "", controllerHost: "" });
  const [clusterId, setClusterId] = useState<string | null>(null);

  const canProgress = (step: number): boolean => {
    if (step === 0) return !!(basics.clusterName && basics.controllerHost);
    return false; // Step 1: wait for agent — no "next" button
  };

  const handleComplete = async () => {
    try {
      const res = await fetch("/api/clusters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: basics.clusterName,
          controllerHost: basics.controllerHost,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Failed to create cluster: ${err.error}`);
        return;
      }
      const cluster = await res.json();
      setClusterId(cluster.id);
    } catch {
      alert("Failed to create cluster");
    }
  };

  return (
    <div className="mx-auto max-w-2xl py-8">
      <h1 className="mb-8 text-3xl font-bold">New Cluster</h1>
      <WizardShell steps={steps} onComplete={handleComplete} canProgress={canProgress}>
        <StepBasics data={basics} onChange={setBasics} />
        <StepInstall clusterId={clusterId} />
      </WizardShell>
    </div>
  );
}
```

- [ ] **Step 4: Expose installToken in cluster GET endpoint**

In `web/app/api/clusters/[id]/route.ts`, add `installToken` and `installTokenExpiresAt` to the select (so StepInstall can fetch the token):

```typescript
// Find the GET handler in the file and add to select:
select: {
  id: true,
  name: true,
  controllerHost: true,
  status: true,
  installToken: true,
  installTokenExpiresAt: true,
  installTokenUsedAt: true,
  config: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { jobs: true } },
}
```

- [ ] **Step 5: Commit**

```bash
git add web/components/wizard/ web/app/(admin)/admin/clusters/new/ web/app/api/clusters/
git commit -m "feat(ui): rework cluster wizard to 2-step agent-first flow"
```

---

## Milestone 2 — Phase 2: Guided Cluster Setup

---

### Task 6: Agent — new command types

**Files:**
- Modify: `agent/internal/message/message.go`

- [ ] **Step 1: Add new command constants**

In `agent/internal/message/message.go`, add to the `const` block:

```go
// Setup commands (Phase 2 guided setup)
CmdTestNfs         CommandType = "test_nfs"
CmdSetupNodes      CommandType = "setup_nodes"
CmdSetupPartitions CommandType = "setup_partitions"

// User provisioning
CmdProvisionUser CommandType = "provision_user"
```

- [ ] **Step 2: Add payload structs**

Add after the existing `CreateHomedirPayload` struct:

```go
// TestNfsPayload is the payload for test_nfs commands.
type TestNfsPayload struct {
	MgmtNfsServer string `json:"mgmt_nfs_server"`
	MgmtNfsPath   string `json:"mgmt_nfs_path"`
	DataNfsServer string `json:"data_nfs_server"`
	DataNfsPath   string `json:"data_nfs_path"`
}

// NodeEntry represents a single node definition for setup_nodes.
type NodeEntry struct {
	Hostname string `json:"hostname"`
	IP       string `json:"ip"`
	CPUs     int    `json:"cpus"`
	MemoryMB int    `json:"memory_mb"`
	GPUs     int    `json:"gpus"`
}

// SetupNodesPayload is the payload for setup_nodes commands.
type SetupNodesPayload struct {
	ControllerHostname string      `json:"controller_hostname"`
	ControllerIsWorker bool        `json:"controller_is_worker"`
	Nodes              []NodeEntry `json:"nodes"`
	SSHPrivateKey      string      `json:"ssh_private_key,omitempty"` // base64-encoded, saved for Ansible
}

// PartitionDef defines a Slurm partition.
type PartitionDef struct {
	Name    string `json:"name"`
	Nodes   string `json:"nodes"`
	MaxTime string `json:"max_time"`
	Default bool   `json:"default"`
}

// SetupPartitionsPayload is the payload for setup_partitions commands.
type SetupPartitionsPayload struct {
	Partitions []PartitionDef `json:"partitions"`
}

// WorkerHost is a hostname/IP pair for Ansible inventory.
type WorkerHost struct {
	Hostname string `json:"hostname"`
	IP       string `json:"ip"`
}

// ProvisionUserPayload is the payload for provision_user commands.
type ProvisionUserPayload struct {
	Username    string       `json:"username"`
	UID         int          `json:"uid"`
	GID         int          `json:"gid"`
	NfsHome     string       `json:"nfs_home"`
	WorkerHosts []WorkerHost `json:"worker_hosts"`
}
```

- [ ] **Step 3: Update dispatcher test to reflect new known types count**

In `agent/internal/handler/dispatcher_test.go`, update the known types slice and count:

```go
func TestDispatcher_UnknownCommand(t *testing.T) {
	knownTypes := []message.CommandType{
		message.CmdSubmitJob,
		message.CmdCancelJob,
		message.CmdListJobs,
		message.CmdJobInfo,
		message.CmdNodeStatus,
		message.CmdActivateNode,
		message.CmdAddNode,
		message.CmdPropagateConfig,
		message.CmdCreateHomedir,
		message.CmdTestNfs,
		message.CmdSetupNodes,
		message.CmdSetupPartitions,
		message.CmdProvisionUser,
	}

	if len(knownTypes) != 13 {
		t.Errorf("expected 13 known command types, got %d", len(knownTypes))
	}
}
```

- [ ] **Step 4: Run agent tests**

```bash
cd agent
go test ./internal/...
```

Expected: PASS (new constants compile, count matches).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/message/message.go agent/internal/handler/dispatcher_test.go
git commit -m "feat(agent): add setup and provision_user command types and payloads"
```

---

### Task 7: Agent setup_handler.go

**Files:**
- Create: `agent/internal/handler/setup_handler.go`

- [ ] **Step 1: Create setup handler**

Create `agent/internal/handler/setup_handler.go`:

```go
package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/scicom/aura/agent/internal/ansible"
	"github.com/scicom/aura/agent/internal/message"
	agentNats "github.com/scicom/aura/agent/internal/nats"
	"github.com/scicom/aura/agent/internal/slurm"
)

// SetupHandler processes Phase 2 cluster setup commands.
type SetupHandler struct {
	publisher   *agentNats.Publisher
	runner      *ansible.Runner
	playbookDir string
	logger      *slog.Logger
}

// NewSetupHandler creates a SetupHandler.
func NewSetupHandler(publisher *agentNats.Publisher, runner *ansible.Runner, playbookDir string, logger *slog.Logger) *SetupHandler {
	return &SetupHandler{
		publisher:   publisher,
		runner:      runner,
		playbookDir: playbookDir,
		logger:      logger,
	}
}

// HandleTestNfs validates NFS shares are reachable and mountable.
func (h *SetupHandler) HandleTestNfs(ctx context.Context, cmd *message.Command) error {
	var payload message.TestNfsPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid test_nfs payload: %w", err))
	}

	h.logger.Info("testing NFS connectivity", "request_id", cmd.RequestID)

	streamFn := func(line string, seq int) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
	}

	seq := 0
	emit := func(line string) {
		streamFn(line, seq)
		seq++
	}

	emit(fmt.Sprintf("[aura] Testing mgmt NFS: %s:%s", payload.MgmtNfsServer, payload.MgmtNfsPath))
	result, err := slurm.RunCommand(ctx, "showmount", "-e", payload.MgmtNfsServer)
	if err != nil || result.ExitCode != 0 {
		msg := fmt.Sprintf("showmount -e %s failed", payload.MgmtNfsServer)
		if result != nil {
			msg = result.Stderr
		}
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("mgmt NFS unreachable: %s", msg))
	}
	emit(result.Stdout)

	emit(fmt.Sprintf("[aura] Testing data NFS: %s:%s", payload.DataNfsServer, payload.DataNfsPath))
	result, err = slurm.RunCommand(ctx, "showmount", "-e", payload.DataNfsServer)
	if err != nil || result.ExitCode != 0 {
		msg := fmt.Sprintf("showmount -e %s failed", payload.DataNfsServer)
		if result != nil {
			msg = result.Stderr
		}
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("data NFS unreachable: %s", msg))
	}
	emit(result.Stdout)
	emit("[aura] NFS connectivity OK")

	return h.publisher.SendResult(cmd.RequestID, map[string]string{"status": "ok"})
}

// HandleSetupNodes writes /etc/hosts, saves SSH key, and runs setup_nodes.yml.
func (h *SetupHandler) HandleSetupNodes(ctx context.Context, cmd *message.Command) error {
	var payload message.SetupNodesPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid setup_nodes payload: %w", err))
	}

	h.logger.Info("setting up nodes", "request_id", cmd.RequestID, "node_count", len(payload.Nodes))

	// Save SSH private key if provided
	if payload.SSHPrivateKey != "" {
		keyBytes, err := base64.StdEncoding.DecodeString(payload.SSHPrivateKey)
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to decode SSH key: %w", err))
		}
		sshDir := "/root/.ssh"
		if err := os.MkdirAll(sshDir, 0700); err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create .ssh dir: %w", err))
		}
		keyPath := filepath.Join(sshDir, "aura_cluster_key")
		if err := os.WriteFile(keyPath, keyBytes, 0600); err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to write SSH key: %w", err))
		}
		_ = h.publisher.SendStreamLine(cmd.RequestID, "[aura] SSH key saved to "+keyPath, 0)
	}

	// Write vars file for Ansible
	type nodeVars struct {
		ControllerHostname string              `json:"controller_hostname"`
		ControllerIsWorker bool                `json:"controller_is_worker"`
		Nodes              []message.NodeEntry `json:"nodes"`
	}
	vars := nodeVars{
		ControllerHostname: payload.ControllerHostname,
		ControllerIsWorker: payload.ControllerIsWorker,
		Nodes:              payload.Nodes,
	}
	varsData, err := json.Marshal(vars)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to marshal vars: %w", err))
	}

	// Build inventory with controller + workers
	inventory := h.buildInventory(payload)

	streamFn := func(line string, seq int) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
	}

	varsPath, cleanup, err := writeTempConfig(json.RawMessage(varsData))
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}
	defer cleanup()

	invPath, err := os.CreateTemp("", "aura-inventory-*.ini")
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create inventory file: %w", err))
	}
	invPath.WriteString(inventory)
	invPath.Close()
	defer os.Remove(invPath.Name())

	opts := &ansible.RunOpts{
		PlaybookDir: h.playbookDir,
		Playbook:    "setup_nodes.yml",
		VarsFile:    varsPath,
		Inventory:   invPath.Name(),
	}

	result, err := h.runner.Run(ctx, opts, streamFn)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("setup_nodes playbook failed: %w", err))
	}
	if result.ExitCode != 0 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("setup_nodes exited with code %d: %s", result.ExitCode, result.Stderr))
	}

	return h.publisher.SendResult(cmd.RequestID, result)
}

// HandleSetupPartitions runs setup_partitions.yml on localhost.
func (h *SetupHandler) HandleSetupPartitions(ctx context.Context, cmd *message.Command) error {
	var payload message.SetupPartitionsPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid setup_partitions payload: %w", err))
	}

	h.logger.Info("setting up partitions", "request_id", cmd.RequestID, "count", len(payload.Partitions))

	type partVars struct {
		Partitions []message.PartitionDef `json:"partitions"`
	}
	varsData, err := json.Marshal(partVars{Partitions: payload.Partitions})
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to marshal partition vars: %w", err))
	}

	varsPath, cleanup, err := writeTempConfig(json.RawMessage(varsData))
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, err)
	}
	defer cleanup()

	streamFn := func(line string, seq int) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
	}

	opts := &ansible.RunOpts{
		PlaybookDir: h.playbookDir,
		Playbook:    "setup_partitions.yml",
		VarsFile:    varsPath,
		Inventory:   "localhost,",
	}

	result, err := h.runner.Run(ctx, opts, streamFn)
	if err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("setup_partitions playbook failed: %w", err))
	}
	if result.ExitCode != 0 {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("setup_partitions exited with code %d: %s", result.ExitCode, result.Stderr))
	}

	return h.publisher.SendResult(cmd.RequestID, result)
}

// buildInventory constructs an Ansible INI inventory from the node list.
func (h *SetupHandler) buildInventory(payload message.SetupNodesPayload) string {
	sshKeyArg := ""
	if _, err := os.Stat("/root/.ssh/aura_cluster_key"); err == nil {
		sshKeyArg = " ansible_ssh_private_key_file=/root/.ssh/aura_cluster_key"
	}

	var sb strings.Builder
	sb.WriteString("[slurm_controllers]\n")
	sb.WriteString(fmt.Sprintf("localhost ansible_connection=local\n\n"))

	sb.WriteString("[slurm_workers]\n")
	for _, n := range payload.Nodes {
		if n.Hostname == payload.ControllerHostname && !payload.ControllerIsWorker {
			continue
		}
		if n.Hostname == payload.ControllerHostname {
			sb.WriteString(fmt.Sprintf("%s ansible_host=%s ansible_user=root ansible_python_interpreter=/usr/bin/python3%s\n",
				n.Hostname, n.IP, sshKeyArg))
		} else {
			sb.WriteString(fmt.Sprintf("%s ansible_host=%s ansible_user=root ansible_python_interpreter=/usr/bin/python3%s\n",
				n.Hostname, n.IP, sshKeyArg))
		}
	}

	return sb.String()
}
```

- [ ] **Step 2: Run agent tests to confirm it compiles**

```bash
cd agent && go build ./...
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add agent/internal/handler/setup_handler.go
git commit -m "feat(agent): add setup handler for test_nfs, setup_nodes, setup_partitions"
```

---

### Task 8: Agent user_handler.go

**Files:**
- Create: `agent/internal/handler/user_handler.go`

- [ ] **Step 1: Create user handler**

Create `agent/internal/handler/user_handler.go`:

```go
package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/scicom/aura/agent/internal/ansible"
	"github.com/scicom/aura/agent/internal/message"
	agentNats "github.com/scicom/aura/agent/internal/nats"
	"github.com/scicom/aura/agent/internal/slurm"
)

// UserHandler processes user provisioning commands.
type UserHandler struct {
	publisher   *agentNats.Publisher
	runner      *ansible.Runner
	playbookDir string
	logger      *slog.Logger
}

// NewUserHandler creates a UserHandler.
func NewUserHandler(publisher *agentNats.Publisher, runner *ansible.Runner, playbookDir string, logger *slog.Logger) *UserHandler {
	return &UserHandler{
		publisher:   publisher,
		runner:      runner,
		playbookDir: playbookDir,
		logger:      logger,
	}
}

// HandleProvisionUser creates a Linux user on master (with NFS home) and replicates to workers.
func (h *UserHandler) HandleProvisionUser(ctx context.Context, cmd *message.Command) error {
	var payload message.ProvisionUserPayload
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("invalid provision_user payload: %w", err))
	}

	h.logger.Info("provisioning user",
		"request_id", cmd.RequestID,
		"username", payload.Username,
		"uid", payload.UID,
	)

	seq := 0
	emit := func(line string) {
		_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq)
		seq++
	}

	// 1. Create group on master
	emit(fmt.Sprintf("[aura] Creating group %s (gid=%d) on master", payload.Username, payload.GID))
	if result, err := slurm.RunCommand(ctx, "groupadd", "-g", fmt.Sprintf("%d", payload.GID), payload.Username); err != nil || (result.ExitCode != 0 && result.ExitCode != 9) {
		// exit code 9 = group already exists, which is fine
		if result != nil && result.ExitCode != 9 {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("groupadd failed: %s", result.Stderr))
		}
	}

	// 2. Create user on master
	emit(fmt.Sprintf("[aura] Creating user %s (uid=%d) on master", payload.Username, payload.UID))
	result, err := slurm.RunCommand(ctx,
		"useradd",
		"-u", fmt.Sprintf("%d", payload.UID),
		"-g", fmt.Sprintf("%d", payload.GID),
		"-d", payload.NfsHome,
		"-M", // don't create home locally
		payload.Username,
	)
	if err != nil || (result.ExitCode != 0 && result.ExitCode != 9) {
		if result != nil && result.ExitCode != 9 {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("useradd failed: %s", result.Stderr))
		}
	}

	// 3. Create NFS home directory
	emit(fmt.Sprintf("[aura] Creating NFS home dir: %s", payload.NfsHome))
	if err := os.MkdirAll(payload.NfsHome, 0755); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create NFS home: %w", err))
	}
	if _, err := slurm.RunCommand(ctx, "chown",
		fmt.Sprintf("%d:%d", payload.UID, payload.GID),
		payload.NfsHome,
	); err != nil {
		return h.publisher.SendError(cmd.RequestID, fmt.Errorf("chown failed: %w", err))
	}
	emit("[aura] NFS home created")

	// 4. Replicate user to workers via Ansible (skip if no workers)
	if len(payload.WorkerHosts) > 0 {
		emit("[aura] Replicating user to worker nodes via Ansible...")

		inventory := h.buildWorkerInventory(payload.WorkerHosts)
		type userVars struct {
			Username string `json:"username"`
			UID      int    `json:"uid"`
			GID      int    `json:"gid"`
		}
		varsData, _ := json.Marshal(userVars{
			Username: payload.Username,
			UID:      payload.UID,
			GID:      payload.GID,
		})

		varsPath, cleanup, err := writeTempConfig(json.RawMessage(varsData))
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, err)
		}
		defer cleanup()

		invFile, err := os.CreateTemp("", "aura-worker-inventory-*.ini")
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("failed to create inventory: %w", err))
		}
		invFile.WriteString(inventory)
		invFile.Close()
		defer os.Remove(invFile.Name())

		streamFn := func(line string, s int) {
			_ = h.publisher.SendStreamLine(cmd.RequestID, line, seq+s)
		}

		opts := &ansible.RunOpts{
			PlaybookDir: h.playbookDir,
			Playbook:    "user_provision.yml",
			VarsFile:    varsPath,
			Inventory:   invFile.Name(),
		}

		ansResult, err := h.runner.Run(ctx, opts, streamFn)
		if err != nil {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("user_provision playbook failed: %w", err))
		}
		if ansResult.ExitCode != 0 {
			return h.publisher.SendError(cmd.RequestID, fmt.Errorf("user_provision exited with code %d: %s", ansResult.ExitCode, ansResult.Stderr))
		}
		emit("[aura] User replicated to all workers")
	}

	emit(fmt.Sprintf("[aura] User %s provisioned successfully (uid=%d)", payload.Username, payload.UID))
	return h.publisher.SendResult(cmd.RequestID, map[string]interface{}{
		"username": payload.Username,
		"uid":      payload.UID,
		"gid":      payload.GID,
	})
}

func (h *UserHandler) buildWorkerInventory(hosts []message.WorkerHost) string {
	sshKeyArg := ""
	if _, err := os.Stat("/root/.ssh/aura_cluster_key"); err == nil {
		sshKeyArg = " ansible_ssh_private_key_file=/root/.ssh/aura_cluster_key"
	}
	var sb strings.Builder
	sb.WriteString("[workers]\n")
	for _, h := range hosts {
		sb.WriteString(fmt.Sprintf("%s ansible_host=%s ansible_user=root ansible_python_interpreter=/usr/bin/python3%s\n",
			h.Hostname, h.IP, sshKeyArg))
	}
	return sb.String()
}
```

- [ ] **Step 2: Register all new handlers in dispatcher**

Replace `agent/internal/handler/dispatcher.go`:

```go
package handler

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/scicom/aura/agent/internal/message"
	agentNats "github.com/scicom/aura/agent/internal/nats"
)

type Dispatcher struct {
	slurm     *SlurmHandler
	deploy    *DeployHandler
	setup     *SetupHandler
	user      *UserHandler
	publisher *agentNats.Publisher
	logger    *slog.Logger
}

func NewDispatcher(
	slurmHandler *SlurmHandler,
	deployHandler *DeployHandler,
	setupHandler *SetupHandler,
	userHandler *UserHandler,
	publisher *agentNats.Publisher,
	logger *slog.Logger,
) *Dispatcher {
	return &Dispatcher{
		slurm:     slurmHandler,
		deploy:    deployHandler,
		setup:     setupHandler,
		user:      userHandler,
		publisher: publisher,
		logger:    logger,
	}
}

func (d *Dispatcher) Dispatch(ctx context.Context, cmd *message.Command) error {
	d.logger.Info("dispatching command", "request_id", cmd.RequestID, "type", cmd.Type)

	switch cmd.Type {
	case message.CmdSubmitJob:
		return d.slurm.HandleSubmitJob(ctx, cmd)
	case message.CmdCancelJob:
		return d.slurm.HandleCancelJob(ctx, cmd)
	case message.CmdListJobs:
		return d.slurm.HandleListJobs(ctx, cmd)
	case message.CmdJobInfo:
		return d.slurm.HandleJobInfo(ctx, cmd)
	case message.CmdNodeStatus:
		return d.slurm.HandleNodeStatus(ctx, cmd)
	case message.CmdActivateNode:
		return d.deploy.HandleActivateNode(ctx, cmd)
	case message.CmdAddNode:
		return d.deploy.HandleAddNode(ctx, cmd)
	case message.CmdPropagateConfig:
		return d.deploy.HandlePropagateConfig(ctx, cmd)
	case message.CmdCreateHomedir:
		return d.deploy.HandleCreateHomedir(ctx, cmd)
	case message.CmdTestNfs:
		return d.setup.HandleTestNfs(ctx, cmd)
	case message.CmdSetupNodes:
		return d.setup.HandleSetupNodes(ctx, cmd)
	case message.CmdSetupPartitions:
		return d.setup.HandleSetupPartitions(ctx, cmd)
	case message.CmdProvisionUser:
		return d.user.HandleProvisionUser(ctx, cmd)
	default:
		err := fmt.Errorf("unknown command type: %s", cmd.Type)
		d.logger.Warn("unknown command type", "request_id", cmd.RequestID, "type", cmd.Type)
		return d.publisher.SendError(cmd.RequestID, err)
	}
}
```

- [ ] **Step 3: Update main.go to wire new handlers**

Find `agent/cmd/agent/main.go` (or wherever `NewDispatcher` is called) and add the new handlers:

```go
setupHandler := handler.NewSetupHandler(publisher, ansibleRunner, cfg.AnsiblePlaybookDir, logger)
userHandler := handler.NewUserHandler(publisher, ansibleRunner, cfg.AnsiblePlaybookDir, logger)
dispatcher := handler.NewDispatcher(slurmHandler, deployHandler, setupHandler, userHandler, publisher, logger)
```

- [ ] **Step 4: Build and verify**

```bash
cd agent && go build ./...
go test ./internal/...
```

Expected: clean build, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/
git commit -m "feat(agent): add user handler and wire setup/user handlers into dispatcher"
```

---

### Task 9: Ansible playbooks for Phase 2 setup

**Files:**
- Create: `ansible/setup_nfs.yml`
- Create: `ansible/setup_nodes.yml`
- Create: `ansible/setup_partitions.yml`

- [ ] **Step 1: Create setup_nfs.yml**

Create `ansible/setup_nfs.yml`:

```yaml
---
- name: Configure NFS mounts on master
  hosts: localhost
  connection: local
  become: true
  tasks:
    - name: Install nfs-common
      apt:
        name: nfs-common
        state: present
        update_cache: true

    - name: Create mgmt mount point
      file:
        path: "{{ mgmt_nfs_path }}"
        state: directory
        mode: "0755"

    - name: Create data mount point
      file:
        path: "{{ data_nfs_path }}"
        state: directory
        mode: "0755"

    - name: Mount mgmt NFS
      mount:
        path: "{{ mgmt_nfs_path }}"
        src: "{{ mgmt_nfs_server }}:{{ mgmt_nfs_path }}"
        fstype: nfs
        opts: defaults,noatime
        state: mounted

    - name: Mount data NFS
      mount:
        path: "{{ data_nfs_path }}"
        src: "{{ data_nfs_server }}:{{ data_nfs_path }}"
        fstype: nfs
        opts: defaults,noatime
        state: mounted
```

- [ ] **Step 2: Create setup_nodes.yml**

Create `ansible/setup_nodes.yml`:

```yaml
---
- name: Write /etc/hosts and configure Slurm nodes on master
  hosts: slurm_controllers
  become: true
  tasks:
    - name: Add cluster nodes to /etc/hosts
      blockinfile:
        path: /etc/hosts
        block: |
          {% for node in nodes %}
          {{ node.ip }} {{ node.hostname }}
          {% endfor %}
        marker: "# {mark} AURA CLUSTER NODES"

    - name: Install Slurm controller packages
      apt:
        name:
          - slurm-wlm
          - slurmctld
        state: present
        update_cache: true

    - name: Write Slurm node definitions
      template:
        src: slurm_nodes.conf.j2
        dest: /etc/slurm/nodes.conf
        owner: slurm
        group: slurm
        mode: "0644"

    - name: Ensure nodes.conf is included in slurm.conf
      lineinfile:
        path: /etc/slurm/slurm.conf
        line: "Include /etc/slurm/nodes.conf"
        state: present
        create: true

- name: Install Slurm compute daemon on workers
  hosts: slurm_workers
  become: true
  tasks:
    - name: Add cluster nodes to /etc/hosts on workers
      blockinfile:
        path: /etc/hosts
        block: |
          {% for node in nodes %}
          {{ node.ip }} {{ node.hostname }}
          {% endfor %}
        marker: "# {mark} AURA CLUSTER NODES"

    - name: Install slurmd on workers
      apt:
        name: slurmd
        state: present
        update_cache: true
```

Create `ansible/templates/slurm_nodes.conf.j2`:

```
{% for node in nodes %}
{% if node.gpus > 0 %}
NodeName={{ node.hostname }} CPUs={{ node.cpus }} RealMemory={{ node.memory_mb }} Gres=gpu:{{ node.gpus }} State=UNKNOWN
{% else %}
NodeName={{ node.hostname }} CPUs={{ node.cpus }} RealMemory={{ node.memory_mb }} State=UNKNOWN
{% endif %}
{% endfor %}
```

- [ ] **Step 3: Create setup_partitions.yml**

Create `ansible/setup_partitions.yml`:

```yaml
---
- name: Configure Slurm partitions and restart slurmctld
  hosts: localhost
  connection: local
  become: true
  tasks:
    - name: Write partition definitions
      template:
        src: slurm_partitions.conf.j2
        dest: /etc/slurm/partitions.conf
        owner: slurm
        group: slurm
        mode: "0644"

    - name: Ensure partitions.conf is included in slurm.conf
      lineinfile:
        path: /etc/slurm/slurm.conf
        line: "Include /etc/slurm/partitions.conf"
        state: present
        create: true

    - name: Restart slurmctld
      systemd:
        name: slurmctld
        state: restarted
        enabled: true
```

Create `ansible/templates/slurm_partitions.conf.j2`:

```
{% for partition in partitions %}
PartitionName={{ partition.name }} Nodes={{ partition.nodes }} MaxTime={{ partition.max_time }}{% if partition.default %} Default=YES{% endif %} State=UP
{% endfor %}
```

- [ ] **Step 4: Commit**

```bash
git add ansible/
git commit -m "feat(ansible): add setup_nfs, setup_nodes, setup_partitions playbooks"
```

---

### Task 10: Phase 2 API routes

**Files:**
- Create: `web/app/api/clusters/[id]/setup/nfs/route.ts`
- Create: `web/app/api/clusters/[id]/setup/nodes/route.ts`
- Create: `web/app/api/clusters/[id]/setup/partitions/route.ts`
- Create: `web/app/api/clusters/[id]/setup/health/route.ts`

- [ ] **Step 1: Create NFS setup route**

Create `web/app/api/clusters/[id]/setup/nfs/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const body = await req.json();
  const { mgmtNfsServer, mgmtNfsPath, dataNfsServer, dataNfsPath, nfsAllowedNetwork } = body;
  if (!mgmtNfsServer || !mgmtNfsPath || !dataNfsServer || !dataNfsPath) {
    return NextResponse.json({ error: "Missing NFS fields" }, { status: 400 });
  }

  // Save to cluster config
  const config = { ...(cluster.config as object), mgmt_nfs_server: mgmtNfsServer, mgmt_nfs_path: mgmtNfsPath, data_nfs_server: dataNfsServer, data_nfs_path: dataNfsPath, nfs_allowed_network: nfsAllowedNetwork };
  await prisma.cluster.update({ where: { id }, data: { config } });

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "test_nfs",
    payload: { mgmt_nfs_server: mgmtNfsServer, mgmt_nfs_path: mgmtNfsPath, data_nfs_server: dataNfsServer, data_nfs_path: dataNfsPath },
  });

  return NextResponse.json({ request_id: requestId });
}
```

- [ ] **Step 2: Create nodes setup route**

Create `web/app/api/clusters/[id]/setup/nodes/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const body = await req.json();
  const { nodes, controllerIsWorker } = body;
  if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
    return NextResponse.json({ error: "nodes array is required" }, { status: 400 });
  }

  // Read SSH key to forward to agent
  let sshPrivateKey = "";
  const keyPath = process.env.ANSIBLE_SSH_KEY_FILE ?? "/home/nextjs/.ssh/id_ed25519";
  try {
    const keyBytes = readFileSync(keyPath);
    sshPrivateKey = keyBytes.toString("base64");
  } catch {
    // SSH key not available — agent will proceed without it (localhost-only ops work)
  }

  // Save nodes to config
  const config = {
    ...(cluster.config as object),
    slurm_hosts_entries: nodes,
    controller_is_worker: controllerIsWorker ?? false,
  };
  await prisma.cluster.update({ where: { id }, data: { config } });

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "setup_nodes",
    payload: {
      controller_hostname: cluster.controllerHost,
      controller_is_worker: controllerIsWorker ?? false,
      nodes,
      ssh_private_key: sshPrivateKey,
    },
  });

  return NextResponse.json({ request_id: requestId });
}
```

- [ ] **Step 3: Create partitions setup route**

Create `web/app/api/clusters/[id]/setup/partitions/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  const body = await req.json();
  const { partitions } = body;
  if (!partitions || !Array.isArray(partitions) || partitions.length === 0) {
    return NextResponse.json({ error: "partitions array is required" }, { status: 400 });
  }

  const config = { ...(cluster.config as object), slurm_partitions: partitions };
  await prisma.cluster.update({ where: { id }, data: { config } });

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "setup_partitions",
    payload: { partitions },
  });

  return NextResponse.json({ request_id: requestId });
}
```

- [ ] **Step 4: Create health check route**

Create `web/app/api/clusters/[id]/setup/health/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendCommandAndWait } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });

  try {
    const result = await sendCommandAndWait(id, {
      request_id: randomUUID(),
      type: "node_status",
    }, 30_000) as any;

    // Mark cluster ACTIVE
    await prisma.cluster.update({ where: { id }, data: { status: "ACTIVE" } });

    return NextResponse.json({ success: true, result });
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "Health check failed" }, { status: 502 });
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add web/app/api/clusters/
git commit -m "feat(api): add Phase 2 setup routes (nfs, nodes, partitions, health)"
```

---

### Task 11: Phase 2 UI — SetupStepper

**Files:**
- Create: `web/components/cluster/setup-stepper.tsx`

- [ ] **Step 1: Create SetupStepper component**

Create `web/components/cluster/setup-stepper.tsx`:

```typescript
"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Check, ChevronRight, Loader2, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

interface NodeRow { hostname: string; ip: string; cpus: number; memoryMb: number; gpus: number }
interface Partition { name: string; nodes: string; maxTime: string; isDefault: boolean }

interface SetupStepperProps { clusterId: string }

type StepStatus = "pending" | "running" | "done" | "error";

interface StepState {
  status: StepStatus;
  logs: string[];
  error?: string;
}

function LogView({ lines, status }: { lines: string[]; status: StepStatus }) {
  return (
    <div className="mt-3 h-48 overflow-y-auto rounded-md border bg-black p-3 font-mono text-xs text-green-400">
      {lines.length === 0 && <span className="text-gray-500">No output yet...</span>}
      {lines.map((l, i) => <div key={i} className="whitespace-pre-wrap leading-5">{l}</div>)}
      {status === "error" && <div className="mt-2 text-red-400">✗ Step failed</div>}
      {status === "done" && <div className="mt-2 text-green-300">✓ Step complete</div>}
    </div>
  );
}

async function runStreamingCommand(
  url: string,
  body: object,
  clusterId: string,
  onLine: (line: string) => void,
): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    onLine(`[error] ${err.error}`);
    return false;
  }
  const { request_id } = await res.json();

  return new Promise((resolve) => {
    const evtSource = new EventSource(`/api/clusters/${clusterId}/stream/${request_id}`);
    evtSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "stream") onLine(event.line);
        else if (event.type === "complete") {
          evtSource.close();
          resolve(event.success);
        }
      } catch {}
    };
    evtSource.onerror = () => { evtSource.close(); resolve(false); };
  });
}

export function SetupStepper({ clusterId }: SetupStepperProps) {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [stepStates, setStepStates] = useState<StepState[]>([
    { status: "pending", logs: [] },
    { status: "pending", logs: [] },
    { status: "pending", logs: [] },
    { status: "pending", logs: [] },
  ]);

  // NFS form
  const [nfs, setNfs] = useState({ mgmtNfsServer: "", mgmtNfsPath: "/mgmt", dataNfsServer: "", dataNfsPath: "/aura-usrdata", nfsAllowedNetwork: "" });

  // Nodes form
  const [nodes, setNodes] = useState<NodeRow[]>([{ hostname: "", ip: "", cpus: 8, memoryMb: 16384, gpus: 0 }]);
  const [controllerIsWorker, setControllerIsWorker] = useState(false);

  // Partitions form
  const [partitions, setPartitions] = useState<Partition[]>([{ name: "compute", nodes: "", maxTime: "24:00:00", isDefault: true }]);

  const setStep = (idx: number, patch: Partial<StepState>) =>
    setStepStates((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  const appendLog = (idx: number, line: string) =>
    setStepStates((prev) => prev.map((s, i) => (i === idx ? { ...s, logs: [...s.logs, line] } : s)));

  // Step 0: NFS
  const runNfs = async () => {
    setStep(0, { status: "running", logs: [] });
    const ok = await runStreamingCommand(
      `/api/clusters/${clusterId}/setup/nfs`,
      nfs,
      clusterId,
      (line) => appendLog(0, line),
    );
    setStep(0, { status: ok ? "done" : "error" });
    if (ok) setCurrentStep(1);
  };

  // Step 1: Nodes
  const runNodes = async () => {
    setStep(1, { status: "running", logs: [] });
    const ok = await runStreamingCommand(
      `/api/clusters/${clusterId}/setup/nodes`,
      { nodes: nodes.map((n) => ({ hostname: n.hostname, ip: n.ip, cpus: n.cpus, memory_mb: n.memoryMb, gpus: n.gpus })), controllerIsWorker },
      clusterId,
      (line) => appendLog(1, line),
    );
    setStep(1, { status: ok ? "done" : "error" });
    if (ok) setCurrentStep(2);
  };

  // Step 2: Partitions
  const runPartitions = async () => {
    setStep(2, { status: "running", logs: [] });
    const ok = await runStreamingCommand(
      `/api/clusters/${clusterId}/setup/partitions`,
      { partitions: partitions.map((p) => ({ name: p.name, nodes: p.nodes, max_time: p.maxTime, default: p.isDefault })) },
      clusterId,
      (line) => appendLog(2, line),
    );
    setStep(2, { status: ok ? "done" : "error" });
    if (ok) setCurrentStep(3);
  };

  // Step 3: Health check
  const runHealth = async () => {
    setStep(3, { status: "running", logs: [] });
    appendLog(3, "[aura] Running health check (sinfo)...");
    const res = await fetch(`/api/clusters/${clusterId}/setup/health`, { method: "POST" });
    const data = await res.json();
    if (data.success) {
      appendLog(3, "[aura] Cluster is healthy and ACTIVE");
      setStep(3, { status: "done" });
      setTimeout(() => router.push(`/admin/clusters/${clusterId}`), 1500);
    } else {
      appendLog(3, `[error] ${data.error}`);
      setStep(3, { status: "error" });
    }
  };

  const stepTitles = ["NFS Storage", "Nodes", "Partitions", "Health Check"];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/40 p-4">
        <p className="text-sm font-medium">Phase 2 — Cluster Configuration</p>
        <p className="text-xs text-muted-foreground mt-1">Agent is connected. Complete each step to finish cluster setup.</p>
      </div>

      {stepTitles.map((title, idx) => {
        const state = stepStates[idx];
        const isActive = idx === currentStep;
        const isLocked = idx > currentStep && stepStates[idx - 1]?.status !== "done";

        return (
          <Card key={idx} className={isLocked ? "opacity-50" : ""}>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                  state.status === "done" ? "bg-green-100 text-green-700" :
                  state.status === "error" ? "bg-red-100 text-red-700" :
                  state.status === "running" ? "bg-blue-100 text-blue-700" :
                  "bg-muted text-muted-foreground"
                }`}>
                  {state.status === "done" ? <Check className="h-4 w-4" /> :
                   state.status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> :
                   idx + 1}
                </div>
                <CardTitle className="text-base">{title}</CardTitle>
                {state.status === "done" && <Badge className="ml-auto bg-green-100 text-green-700">Done</Badge>}
                {state.status === "error" && <Badge className="ml-auto" variant="destructive">Failed</Badge>}
              </div>
            </CardHeader>

            {isActive && (
              <CardContent className="space-y-4 pt-0">
                {/* NFS Form */}
                {idx === 0 && (
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Mgmt NFS Server", key: "mgmtNfsServer", placeholder: "192.168.1.100" },
                      { label: "Mgmt NFS Path", key: "mgmtNfsPath", placeholder: "/mgmt" },
                      { label: "Data NFS Server", key: "dataNfsServer", placeholder: "192.168.1.100" },
                      { label: "Data NFS Path", key: "dataNfsPath", placeholder: "/aura-usrdata" },
                      { label: "Allowed Network", key: "nfsAllowedNetwork", placeholder: "192.168.1.0/24" },
                    ].map(({ label, key, placeholder }) => (
                      <div key={key} className="space-y-1">
                        <Label className="text-xs">{label}</Label>
                        <Input
                          placeholder={placeholder}
                          value={(nfs as any)[key]}
                          onChange={(e) => setNfs((p) => ({ ...p, [key]: e.target.value }))}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* Nodes Form */}
                {idx === 1 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="ctrl-worker"
                        checked={controllerIsWorker}
                        onCheckedChange={(v) => setControllerIsWorker(!!v)}
                      />
                      <Label htmlFor="ctrl-worker" className="text-sm">Controller node is also a compute node</Label>
                    </div>
                    <div className="space-y-2">
                      {nodes.map((node, ni) => (
                        <div key={ni} className="grid grid-cols-6 gap-2 items-end">
                          <div className="col-span-2 space-y-1">
                            {ni === 0 && <Label className="text-xs">Hostname</Label>}
                            <Input placeholder="node-01" value={node.hostname} onChange={(e) => setNodes((p) => p.map((n, i) => i === ni ? { ...n, hostname: e.target.value } : n))} />
                          </div>
                          <div className="space-y-1">
                            {ni === 0 && <Label className="text-xs">IP</Label>}
                            <Input placeholder="10.0.0.2" value={node.ip} onChange={(e) => setNodes((p) => p.map((n, i) => i === ni ? { ...n, ip: e.target.value } : n))} />
                          </div>
                          <div className="space-y-1">
                            {ni === 0 && <Label className="text-xs">CPUs</Label>}
                            <Input type="number" value={node.cpus} onChange={(e) => setNodes((p) => p.map((n, i) => i === ni ? { ...n, cpus: +e.target.value } : n))} />
                          </div>
                          <div className="space-y-1">
                            {ni === 0 && <Label className="text-xs">Mem (MB)</Label>}
                            <Input type="number" value={node.memoryMb} onChange={(e) => setNodes((p) => p.map((n, i) => i === ni ? { ...n, memoryMb: +e.target.value } : n))} />
                          </div>
                          <div className="space-y-1">
                            {ni === 0 && <Label className="text-xs">GPUs</Label>}
                            <div className="flex gap-1">
                              <Input type="number" value={node.gpus} onChange={(e) => setNodes((p) => p.map((n, i) => i === ni ? { ...n, gpus: +e.target.value } : n))} />
                              {nodes.length > 1 && (
                                <Button variant="ghost" size="icon" onClick={() => setNodes((p) => p.filter((_, i) => i !== ni))}>
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setNodes((p) => [...p, { hostname: "", ip: "", cpus: 8, memoryMb: 16384, gpus: 0 }])}>
                      <Plus className="mr-1 h-4 w-4" /> Add Node
                    </Button>
                  </div>
                )}

                {/* Partitions Form */}
                {idx === 2 && (
                  <div className="space-y-2">
                    {partitions.map((p, pi) => (
                      <div key={pi} className="grid grid-cols-5 gap-2 items-end">
                        <div className="space-y-1">
                          {pi === 0 && <Label className="text-xs">Name</Label>}
                          <Input placeholder="compute" value={p.name} onChange={(e) => setPartitions((prev) => prev.map((x, i) => i === pi ? { ...x, name: e.target.value } : x))} />
                        </div>
                        <div className="space-y-1">
                          {pi === 0 && <Label className="text-xs">Nodes</Label>}
                          <Input placeholder="node-[01-10]" value={p.nodes} onChange={(e) => setPartitions((prev) => prev.map((x, i) => i === pi ? { ...x, nodes: e.target.value } : x))} />
                        </div>
                        <div className="space-y-1">
                          {pi === 0 && <Label className="text-xs">Max Time</Label>}
                          <Input placeholder="24:00:00" value={p.maxTime} onChange={(e) => setPartitions((prev) => prev.map((x, i) => i === pi ? { ...x, maxTime: e.target.value } : x))} />
                        </div>
                        <div className="space-y-1 flex flex-col">
                          {pi === 0 && <Label className="text-xs">Default</Label>}
                          <div className="flex items-center h-9">
                            <Checkbox checked={p.isDefault} onCheckedChange={(v) => setPartitions((prev) => prev.map((x, i) => i === pi ? { ...x, isDefault: !!v } : x))} />
                          </div>
                        </div>
                        <div className="space-y-1">
                          {pi === 0 && <Label className="text-xs invisible">Del</Label>}
                          {partitions.length > 1 && (
                            <Button variant="ghost" size="icon" onClick={() => setPartitions((prev) => prev.filter((_, i) => i !== pi))}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={() => setPartitions((p) => [...p, { name: "", nodes: "", maxTime: "24:00:00", isDefault: false }])}>
                      <Plus className="mr-1 h-4 w-4" /> Add Partition
                    </Button>
                  </div>
                )}

                {/* Health check step */}
                {idx === 3 && (
                  <p className="text-sm text-muted-foreground">
                    Runs <code>sinfo</code> via the agent to verify Slurm is healthy. On success the cluster becomes <strong>ACTIVE</strong>.
                  </p>
                )}

                {state.logs.length > 0 && <LogView lines={state.logs} status={state.status} />}

                {state.status !== "running" && (
                  <Button
                    onClick={idx === 0 ? runNfs : idx === 1 ? runNodes : idx === 2 ? runPartitions : runHealth}
                    disabled={state.status === "running"}
                  >
                    {state.status === "error" ? "Retry" : idx === 3 ? "Run Health Check" : "Apply"}
                    {state.status !== "running" && <ChevronRight className="ml-1 h-4 w-4" />}
                    {state.status === "running" && <Loader2 className="ml-1 h-4 w-4 animate-spin" />}
                  </Button>
                )}
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Add SetupStepper to cluster detail page**

Modify `web/app/(admin)/admin/clusters/[id]/page.tsx` — convert to a client component that conditionally renders the stepper when status is `PROVISIONING`. Add at the top of the return, right before the stats grid:

```typescript
// At the top of the file, add:
import { SetupStepper } from "@/components/cluster/setup-stepper";

// In the JSX, replace the stats grid + separator section with:
{cluster.status === "PROVISIONING" ? (
  <SetupStepper clusterId={id} />
) : (
  <>
    <div className="grid gap-4 md:grid-cols-3">
      {/* ... existing cards ... */}
    </div>
    <Separator />
    <ConfigEditor clusterId={id} initialConfig={config} />
  </>
)}
```

Since this page is a server component, the `SetupStepper` client island is rendered on the client. No changes needed to make the page itself a client component.

- [ ] **Step 3: Commit**

```bash
git add web/components/cluster/ web/app/(admin)/admin/clusters/
git commit -m "feat(ui): add Phase 2 SetupStepper component and wire into cluster detail page"
```

---

## Milestone 3 — User Provisioning

---

### Task 12: Ansible user_provision.yml

**Files:**
- Create: `ansible/roles/aura_user/defaults/main.yml`
- Create: `ansible/roles/aura_user/tasks/main.yml`
- Create: `ansible/user_provision.yml`

- [ ] **Step 1: Create aura_user role**

Create `ansible/roles/aura_user/defaults/main.yml`:

```yaml
---
username: ""
uid: 0
gid: 0
```

Create `ansible/roles/aura_user/tasks/main.yml`:

```yaml
---
- name: Create user group
  group:
    name: "{{ username }}"
    gid: "{{ gid }}"
    state: present

- name: Create user account
  user:
    name: "{{ username }}"
    uid: "{{ uid }}"
    group: "{{ username }}"
    create_home: false  # home is on NFS, already created by master
    shell: /bin/bash
    state: present
```

Create `ansible/user_provision.yml`:

```yaml
---
- name: Provision user on worker nodes
  hosts: workers
  become: true
  roles:
    - aura_user
```

- [ ] **Step 2: Commit**

```bash
git add ansible/roles/aura_user/ ansible/user_provision.yml
git commit -m "feat(ansible): add aura_user role and user_provision playbook"
```

---

### Task 13: Web API — cluster users endpoints

**Files:**
- Create: `web/app/api/clusters/[id]/users/route.ts`
- Create: `web/app/api/clusters/[id]/users/[userId]/route.ts`

- [ ] **Step 1: Create users list + provision endpoint**

Create `web/app/api/clusters/[id]/users/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishCommand } from "@/lib/nats";
import { randomUUID } from "crypto";

interface RouteParams { params: Promise<{ id: string }> }

// GET /api/clusters/[id]/users — list provisioned users
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const clusterUsers = await prisma.clusterUser.findMany({
    where: { clusterId: id },
    include: { user: { select: { id: true, email: true, name: true, unixUid: true, unixGid: true } } },
    orderBy: { provisionedAt: "desc" },
  });

  return NextResponse.json(clusterUsers);
}

// POST /api/clusters/[id]/users — provision a user to this cluster
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({ where: { id } });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (cluster.status !== "ACTIVE") {
    return NextResponse.json({ error: "Cluster must be ACTIVE to provision users" }, { status: 409 });
  }

  const { userId } = await req.json();
  if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Check not already provisioned
  const existing = await prisma.clusterUser.findUnique({
    where: { userId_clusterId: { userId, clusterId: id } },
  });
  if (existing && existing.status === "ACTIVE") {
    return NextResponse.json({ error: "User already provisioned to this cluster" }, { status: 409 });
  }

  // Allocate UID if not yet assigned (global, starting from 10000)
  let { unixUid, unixGid } = user;
  if (!unixUid) {
    const maxResult = await prisma.user.aggregate({ _max: { unixUid: true } });
    unixUid = (maxResult._max.unixUid ?? 9999) + 1;
    unixGid = unixUid;
    await prisma.user.update({ where: { id: userId }, data: { unixUid, unixGid } });
  }

  // Create or reset ClusterUser record
  const clusterUser = await prisma.clusterUser.upsert({
    where: { userId_clusterId: { userId, clusterId: id } },
    create: { userId, clusterId: id, status: "PENDING" },
    update: { status: "PENDING", provisionedAt: null },
  });

  // Build worker hosts from cluster config
  const config = cluster.config as Record<string, unknown>;
  const hostsEntries = (config.slurm_hosts_entries ?? []) as Array<{ hostname: string; ip: string }>;
  const controllerHost = cluster.controllerHost;
  const workerHosts = hostsEntries
    .filter((h) => h.hostname !== controllerHost)
    .map((h) => ({ hostname: h.hostname, ip: h.ip }));

  const dataNfsPath = (config.data_nfs_path as string) ?? "/aura-usrdata";
  const username = user.email.split("@")[0].replace(/[^a-z0-9_]/gi, "_").toLowerCase();

  const requestId = randomUUID();
  await publishCommand(id, {
    request_id: requestId,
    type: "provision_user",
    payload: {
      username,
      uid: unixUid,
      gid: unixGid,
      nfs_home: `${dataNfsPath}/${username}`,
      worker_hosts: workerHosts,
    },
  });

  return NextResponse.json({ request_id: requestId, clusterUserId: clusterUser.id });
}
```

- [ ] **Step 2: Create ClusterUser status update endpoint**

Create `web/app/api/clusters/[id]/users/[userId]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteParams { params: Promise<{ id: string; userId: string }> }

// PATCH /api/clusters/[id]/users/[userId] — update provisioning status after SSE reply
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, userId } = await params;
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { status } = await req.json();
  if (!["ACTIVE", "FAILED"].includes(status)) {
    return NextResponse.json({ error: "status must be ACTIVE or FAILED" }, { status: 400 });
  }

  const clusterUser = await prisma.clusterUser.update({
    where: { userId_clusterId: { userId, clusterId: id } },
    data: {
      status,
      provisionedAt: status === "ACTIVE" ? new Date() : undefined,
    },
  });

  return NextResponse.json(clusterUser);
}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/clusters/
git commit -m "feat(api): add cluster users endpoints (list, provision, status update)"
```

---

### Task 14: Users tab UI

**Files:**
- Create: `web/components/cluster/users-tab.tsx`
- Modify: `web/app/(admin)/admin/clusters/[id]/page.tsx`

- [ ] **Step 1: Create UsersTab component**

Create `web/components/cluster/users-tab.tsx`:

```typescript
"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, UserPlus } from "lucide-react";

interface ClusterUserRow {
  id: string;
  status: "PENDING" | "ACTIVE" | "FAILED";
  provisionedAt: string | null;
  user: { id: string; email: string; name: string | null; unixUid: number | null };
}

interface AllUser { id: string; email: string; name: string | null }

interface UsersTabProps { clusterId: string }

function StatusBadge({ status }: { status: string }) {
  if (status === "ACTIVE") return <Badge className="bg-green-100 text-green-700">Active</Badge>;
  if (status === "FAILED") return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="outline">Pending</Badge>;
}

export function UsersTab({ clusterId }: UsersTabProps) {
  const [clusterUsers, setClusterUsers] = useState<ClusterUserRow[]>([]);
  const [allUsers, setAllUsers] = useState<AllUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [provisioning, setProvisioning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchClusterUsers = () =>
    fetch(`/api/clusters/${clusterId}/users`)
      .then((r) => r.json())
      .then(setClusterUsers)
      .catch(() => {});

  useEffect(() => {
    fetchClusterUsers();
    fetch("/api/users")
      .then((r) => r.json())
      .then(setAllUsers)
      .catch(() => {});
  }, [clusterId]);

  const handleProvision = async () => {
    if (!selectedUserId) return;
    setProvisioning(true);
    setLogs(["[aura] Starting user provisioning..."]);

    const res = await fetch(`/api/clusters/${clusterId}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: selectedUserId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      setLogs((p) => [...p, `[error] ${err.error}`]);
      setProvisioning(false);
      return;
    }

    const { request_id } = await res.json();

    const evtSource = new EventSource(`/api/clusters/${clusterId}/stream/${request_id}`);
    evtSource.onmessage = async (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "stream") {
          setLogs((p) => [...p, event.line]);
        } else if (event.type === "complete") {
          evtSource.close();
          const newStatus = event.success ? "ACTIVE" : "FAILED";
          await fetch(`/api/clusters/${clusterId}/users/${selectedUserId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: newStatus }),
          });
          setLogs((p) => [...p, event.success ? "[aura] User provisioned successfully." : `[error] ${event.payload?.error ?? "Provisioning failed"}`]);
          setProvisioning(false);
          fetchClusterUsers();
        }
      } catch {}
    };
    evtSource.onerror = () => {
      evtSource.close();
      setLogs((p) => [...p, "[error] SSE connection lost"]);
      setProvisioning(false);
    };
  };

  const alreadyProvisioned = new Set(clusterUsers.map((cu) => cu.user.id));
  const availableUsers = allUsers.filter((u) => !alreadyProvisioned.has(u.id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{clusterUsers.length} user(s) provisioned</p>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <UserPlus className="mr-2 h-4 w-4" /> Add User
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Provision User</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a user..." />
                </SelectTrigger>
                <SelectContent>
                  {availableUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name ?? u.email} ({u.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {logs.length > 0 && (
                <div className="h-48 overflow-y-auto rounded-md border bg-black p-3 font-mono text-xs text-green-400">
                  {logs.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              )}

              <Button onClick={handleProvision} disabled={!selectedUserId || provisioning} className="w-full">
                {provisioning ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Provisioning...</> : "Provision"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {clusterUsers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Plus className="mb-2 h-8 w-8" />
            <p>No users provisioned yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-2 text-left font-medium">User</th>
                <th className="px-4 py-2 text-left font-medium">UID</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Provisioned</th>
              </tr>
            </thead>
            <tbody>
              {clusterUsers.map((cu) => (
                <tr key={cu.id} className="border-b last:border-0">
                  <td className="px-4 py-2">
                    <div>{cu.user.name ?? cu.user.email}</div>
                    <div className="text-xs text-muted-foreground">{cu.user.email}</div>
                  </td>
                  <td className="px-4 py-2 font-mono">{cu.user.unixUid ?? "—"}</td>
                  <td className="px-4 py-2"><StatusBadge status={cu.status} /></td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {cu.provisionedAt ? new Date(cu.provisionedAt).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add /api/users endpoint for the user search dropdown**

Create `web/app/api/users/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, unixUid: true },
    orderBy: { email: "asc" },
  });
  return NextResponse.json(users);
}
```

- [ ] **Step 3: Add Users tab to cluster detail page**

In `web/app/(admin)/admin/clusters/[id]/page.tsx`, add the Users tab below the ConfigEditor (only shown when status is `ACTIVE`):

```typescript
// Add import at top:
import { UsersTab } from "@/components/cluster/users-tab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Replace the bottom section (after the Separator) with:
{cluster.status === "ACTIVE" && (
  <Tabs defaultValue="config">
    <TabsList>
      <TabsTrigger value="config">Configuration</TabsTrigger>
      <TabsTrigger value="users">Users</TabsTrigger>
    </TabsList>
    <TabsContent value="config">
      <ConfigEditor clusterId={id} initialConfig={config} />
    </TabsContent>
    <TabsContent value="users">
      <UsersTab clusterId={id} />
    </TabsContent>
  </Tabs>
)}
```

- [ ] **Step 4: Commit**

```bash
git add web/components/cluster/users-tab.tsx web/app/api/users/ web/app/(admin)/admin/clusters/
git commit -m "feat(ui): add users tab with provision dialog to cluster detail page"
```

---

### Task 15: Final build verification

- [ ] **Step 1: Run agent full build and tests**

```bash
cd agent
go build ./...
go test ./internal/... -v
```

Expected: all pass.

- [ ] **Step 2: Run web type check**

```bash
cd web
npx tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 3: Run web build**

```bash
cd web
npm run build
```

Expected: clean build, no errors.

- [ ] **Step 4: Push**

```bash
git push origin main
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Phase 1 wizard (2 steps: Basics + Install)
- ✅ Install token (UUID, 1hr expiry, single-use, stored on Cluster model)
- ✅ Install script served from `/api/install/[token]` (no auth)
- ✅ Binary served from `/api/install/[token]/binary`
- ✅ Token regeneration at `/api/clusters/[id]/install-token`
- ✅ Heartbeat SSE detection at `/api/clusters/[id]/heartbeat/stream`
- ✅ Phase 2 guided stepper (NFS → Nodes → Partitions → Health)
- ✅ Master-as-worker checkbox in nodes step
- ✅ GPU field in node row
- ✅ `test_nfs`, `setup_nodes`, `setup_partitions` agent commands
- ✅ SSH key forwarded to agent in `setup_nodes` payload
- ✅ `provision_user` agent command (create user + NFS home + Ansible to workers)
- ✅ Global UID allocation starting from 10000
- ✅ `ClusterUser` model + status lifecycle (PENDING → ACTIVE/FAILED)
- ✅ Users tab with provision dialog + live SSE log
- ✅ `user_provision.yml` Ansible playbook + `aura_user` role

**Type consistency:** All payload structs in message.go match what the handlers unmarshal. `ProvisionUserPayload.WorkerHosts` uses `[]WorkerHost` which is defined in same file. `publishCommand` payload field names use snake_case matching Go struct JSON tags.

**Gotcha:** `main.go` wiring (Task 8, Step 3) — find the file and add the two new handler instantiations. The exact path is `agent/cmd/agent/main.go`.
