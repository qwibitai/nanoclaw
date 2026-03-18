# NanoClaw Host Process
# Orchestrator that spawns sibling agent containers via Docker socket.
# Uses Docker-out-of-Docker: needs /var/run/docker.sock mounted at runtime.

FROM node:22-slim AS build

# better-sqlite3 requires native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies (layer cached separately from source)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build TypeScript
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm run build

# --- Production stage ---
FROM node:22-slim

# Docker CLI for Docker-out-of-Docker (just the CLI, not the daemon)
RUN apt-get update \
    && apt-get install -y ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
       | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
       https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Install production dependencies only
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy built output and runtime assets
COPY --from=build /app/dist ./dist
COPY container/ container/
COPY CLAUDE.md ./
COPY docs/ docs/

# Three-root model: APP_DIR is baked into the image,
# CONFIG_DIR and DATA_DIR are mounted at runtime.
ENV NANOCLAW_APP_DIR=/app

VOLUME ["/data", "/config"]
EXPOSE 3001

CMD ["node", "dist/index.js"]
