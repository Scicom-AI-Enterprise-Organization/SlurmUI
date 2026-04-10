#!/bin/bash
set -e

echo "[cluster-node] Starting SSH daemon..."
/usr/sbin/sshd -D &
SSH_PID=$!

# Watch for the agent binary to appear (deployed by Ansible bootstrap)
echo "[cluster-node] Waiting for aura-agent binary at /usr/local/bin/aura-agent..."
while [ ! -x /usr/local/bin/aura-agent ]; do
  sleep 2
done

echo "[cluster-node] aura-agent found. Starting..."
# Source env file written by bootstrap
if [ -f /etc/aura-agent/agent.env ]; then
  export $(grep -v '^#' /etc/aura-agent/agent.env | xargs)
fi

/usr/local/bin/aura-agent &
AGENT_PID=$!

echo "[cluster-node] aura-agent started (PID $AGENT_PID)"
echo "[cluster-node] NATS_URL=$NATS_URL"
echo "[cluster-node] CLUSTER_ID=$CLUSTER_ID"

# Wait for either process to exit
wait $SSH_PID $AGENT_PID
