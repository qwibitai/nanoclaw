# NanoClaw orchestrator service for Dokploy deployment.
# Manages agent containers, WhatsApp channel, and Warren channel.
#
# Multi-stage build: keeps build tools (python3, make, g++) out of the
# runtime image, reducing size by ~500MB and avoiding OOM kills.

# --- Stage 1: build ---
FROM node:22-slim AS builder

# Build tools for native Node addons (better-sqlite3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

ARG CACHEBUST=1
COPY . .
RUN npm run build

# Remove devDependencies to slim down node_modules for runtime
RUN npm prune --omit=dev

# --- Stage 2: runtime ---
FROM node:22-slim

# Only the Docker CLI — copied from official image instead of installing
# the full docker.io package (~300MB savings)
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app

# Copy only what's needed at runtime
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

ENV DATA_DIR=/app/data
ENV NODE_ENV=production

# Include agent container source so we can build the image at startup
COPY --from=builder /app/container ./container

VOLUME ["/app/data"]

# Build the agent image (requires Docker socket) then start NanoClaw
ENV DOCKER_BUILDKIT=1
CMD docker build -t nanoclaw-agent:latest /app/container && node dist/index.js
