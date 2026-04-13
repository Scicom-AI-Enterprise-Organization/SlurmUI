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
