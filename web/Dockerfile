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
# Compile the custom server to plain JS so production runs with `node` (not tsx).
# Running tsx in prod registers a require-hook that breaks Next's export-condition
# resolution for async-local-storage.
RUN npm install --no-save esbuild && \
    npx esbuild server.ts \
      --bundle --platform=node --target=node20 --format=cjs \
      --outfile=server.js \
      --external:next --external:next-auth --external:next-auth/* \
      --external:@auth/prisma-adapter --external:@prisma/client

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

# Copy the pre-compiled custom server
COPY --from=builder /app/server.js ./server.js

USER nextjs
EXPOSE 3000

# Run with custom server for WebSocket support
CMD ["node", "server.js"]
