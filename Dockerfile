# Build context: repo root (scicom-aura/)
# This Dockerfile is used by the CI/CD pipeline for K8s/ArgoCD deployment.
# For local dev, use web/docker-compose.dev.yml instead.

# ---- Agent binaries (amd64 + arm64 for x86 and GPU/ARM nodes) ----
FROM golang:1.25-alpine AS agent-builder
ARG BUILD_VERSION=dev
WORKDIR /build
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags "-s -w -X main.Version=${BUILD_VERSION}" \
    -o aura-agent-amd64 ./cmd/aura-agent && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build \
    -ldflags "-s -w -X main.Version=${BUILD_VERSION}" \
    -o aura-agent-arm64 ./cmd/aura-agent

# ---- Node.js dependency install ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./
COPY web/prisma ./prisma/
RUN apk add --no-cache openssl && npm ci

# ---- Next.js build ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/ .
RUN apk add --no-cache openssl
RUN npx prisma generate
RUN npm run build

# Compile the custom server to an ESM bundle so prod runs it with plain `node`
# (no tsx at runtime — tsx's require-hook breaks Next's own require-hook that
# resolves AsyncLocalStorage across react-server/default export conditions).
# Externals stay as runtime deps so their own module resolution (and Next's
# hook) aren't bypassed by the bundler.
RUN npm install --no-save esbuild && \
    npx esbuild server.ts \
      --bundle --platform=node --target=node20 --format=esm \
      --outfile=server.mjs \
      --external:next --external:next/* \
      --external:next-auth --external:next-auth/* \
      --external:@auth/prisma-adapter --external:@prisma/client \
      --external:ws --external:nats

# next has no `exports` field, so `import "next/server"` from next-auth's ESM
# files fails under Node's strict ESM resolver. Rewrite those imports in-place
# to include the `.js` extension so plain filesystem resolution works.
RUN find node_modules/next-auth -name '*.js' -type f -exec \
    sed -i -E 's#from "next/(server|headers|navigation|cache)"#from "next/\1.js"#g' {} +

# ---- Production runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install Ansible + SSH client for cluster bootstrap
RUN apk add --no-cache openssl python3 py3-pip openssh-client git curl ca-certificates && \
    pip3 install --break-system-packages ansible-core==2.16.* && \
    rm -rf /root/.cache/pip

# cloudflared — used to front the web tier with a Cloudflare Tunnel without
# exposing a public LB. Pinned via ARG so CI can bump without editing this
# file; `latest` resolves to Cloudflare's latest GA release.
ARG CLOUDFLARED_VERSION=latest
RUN set -eux; \
    arch=$(uname -m); \
    case "$arch" in \
      x86_64)  asset=cloudflared-linux-amd64 ;; \
      aarch64) asset=cloudflared-linux-arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    if [ "$CLOUDFLARED_VERSION" = "latest" ]; then \
      url="https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}"; \
    else \
      url="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}"; \
    fi; \
    curl -fsSL -o /usr/local/bin/cloudflared "$url"; \
    chmod +x /usr/local/bin/cloudflared; \
    cloudflared --version

# System user for the app
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy full install from builder (includes the patched next/package.json).
# We avoid Next.js standalone output because it trims node_modules and strips
# next-auth's dependency on `next/server`.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/server.mjs ./server.mjs
COPY --from=builder /app/preload.cjs ./preload.cjs
COPY --from=builder /app/next.config.* ./
RUN chown -R nextjs:nodejs node_modules/.prisma node_modules/@prisma/engines

# Ansible playbooks bundled into the image
COPY ansible/ /opt/aura/ansible/

# Agent binaries for both architectures
COPY --from=agent-builder /build/aura-agent-amd64 /opt/aura/aura-agent-amd64
COPY --from=agent-builder /build/aura-agent-arm64 /opt/aura/aura-agent-arm64

# SSH dir for ansible (key is mounted at runtime via K8s Secret)
RUN mkdir -p /home/nextjs/.ssh && chown nextjs:nodejs /home/nextjs/.ssh

USER nextjs
EXPOSE 3000

ENV ANSIBLE_PLAYBOOKS_DIR=/opt/aura/ansible
ENV AURA_AGENT_BINARY_DIR=/opt/aura

CMD ["node", "-r", "./preload.cjs", "server.mjs"]
