# NanoClaw orchestrator service for Dokploy deployment.
# Manages agent containers, WhatsApp channel, and Warren channel.

FROM node:22-slim

# Install Docker CLI (for spawning agent containers) and build tools
# for native Node addons (better-sqlite3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      docker.io \
      curl \
      python3 \
      make \
      g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (separate for Docker layer caching)
COPY package*.json ./
RUN npm ci

# Copy source and build (ARG busts cache when source changes)
ARG CACHEBUST=1
COPY . .
RUN npm run build

# Default environment
ENV DATA_DIR=/app/data
ENV NODE_ENV=production

# Data directory for SQLite, auth state, group configs
VOLUME ["/app/data"]

CMD ["node", "dist/index.js"]
