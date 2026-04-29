# ---- Base ----
FROM node:20-alpine AS base
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm ci

# ---- Build ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# ---- Production ----
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Copy custom server
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/lib ./lib

# Copy hand-rolled Grafana dashboards (vllm-grafana-classic.json,
# -v1.json, -v2.json). Read at deploy time by tryReadDashboard() and
# baked into the cluster's Grafana via the deploy script. Not part of
# .next/standalone so it must be copied explicitly.
COPY --from=builder /app/dashboards ./dashboards

# Install tsx for running TypeScript server in production
RUN npm install tsx

USER nextjs
EXPOSE 3000

# Run with custom server for WebSocket support
CMD ["npx", "tsx", "server.ts"]
