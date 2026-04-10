# Build context: repo root (scicom-aura/)
# This Dockerfile is used by the CI/CD pipeline for K8s/ArgoCD deployment.
# For local dev, use web/docker-compose.dev.yml instead.

# ---- Agent binary (linux/amd64 for most K8s nodes) ----
FROM golang:1.24-alpine AS agent-builder
WORKDIR /build
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags "-s -w -X main.Version=$(cat go.mod | grep ^module | awk '{print "0.1.0"}')" \
    -o aura-agent ./cmd/aura-agent

# ---- Node.js dependency install ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./
COPY web/prisma ./prisma/
RUN npm ci

# ---- Next.js build ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/ .
RUN npx prisma generate
RUN npm run build

# ---- Production runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install Ansible + SSH client for cluster bootstrap
RUN apk add --no-cache python3 py3-pip openssh-client git && \
    pip3 install --break-system-packages ansible-core==2.16.* && \
    rm -rf /root/.cache/pip

# System user for the app
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Production Node.js dependencies (includes nats, ws, prisma runtime)
COPY web/package.json web/package-lock.json ./
COPY web/prisma ./prisma/
RUN npm ci --omit=dev && npx prisma generate

# Next.js standalone output + static assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Custom TypeScript server (needs tsx + runtime deps above)
COPY web/server.ts ./server.ts
COPY web/lib ./lib

# Ansible playbooks bundled into the image
COPY ansible/ /opt/aura/ansible/

# Agent binary for Ansible to deploy onto cluster nodes
COPY --from=agent-builder /build/aura-agent /opt/aura/aura-agent

# SSH dir for ansible (key is mounted at runtime via K8s Secret)
RUN mkdir -p /home/nextjs/.ssh && chown nextjs:nodejs /home/nextjs/.ssh

USER nextjs
EXPOSE 3000

ENV ANSIBLE_PLAYBOOKS_DIR=/opt/aura/ansible
ENV AURA_AGENT_BINARY_SRC=/opt/aura/aura-agent

CMD ["npx", "tsx", "server.ts"]
