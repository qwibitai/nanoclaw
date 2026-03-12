# NanoClaw main orchestrator — runs channels, spawns agent containers
FROM node:22-slim

# Docker CLI only (socket mounted at runtime)
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY setup ./setup
RUN npm run build

# Config dir for mount allowlist (created at runtime if needed)
ENV HOME=/app
RUN mkdir -p /app/.config/nanoclaw

# Agent image must be built separately: ./container/build.sh
# Then: docker compose up -d
CMD ["node", "dist/index.js"]
