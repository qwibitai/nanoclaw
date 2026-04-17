# NanoClaw — Personal Claude assistant orchestrator
# Multi-stage build: compile TypeScript, then run from minimal image

# --- Stage 1: Build ---
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# --- Stage 2: Production ---
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY setup/ ./setup/
COPY groups/ ./groups/
COPY container/ ./container/
COPY scripts/ ./scripts/

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fs http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
