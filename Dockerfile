# NanoClaw Server
# Main Node.js app that connects to WhatsApp and routes messages to agent containers

FROM node:22-slim AS builder

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY src ./src
COPY tsconfig.json ./

# Build TypeScript
RUN pnpm run build

# Production stage
FROM node:22-slim

# Install runtime dependencies and build tools for native modules
RUN apt-get update && apt-get install -y \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm for production deps
RUN npm install -g pnpm

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only (includes native module compilation)
RUN pnpm install --frozen-lockfile --prod \
    && rm -rf /root/.cache /root/.npm

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy groups directory structure (will be mounted in production)
COPY groups ./groups

# Create directories for runtime data
RUN mkdir -p /app/store /app/auth

# Run as non-root
RUN useradd -m -s /bin/bash nanoclaw && chown -R nanoclaw:nanoclaw /app
USER nanoclaw

# Default command
CMD ["node", "dist/index.js"]
