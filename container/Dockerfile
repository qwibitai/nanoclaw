# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Pre-create tsconfig for runtime compilation from merged source in /tmp/src.
# Placed in /app so node_modules resolution works correctly.
RUN echo '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","outDir":"/tmp/dist","rootDir":"/tmp/src","strict":true,"esModuleInterop":true,"skipLibCheck":true},"include":["/tmp/src/**/*"]}' > /app/tsconfig.build.json

# Create entrypoint script
# Source merging: /app/src-global (read-only mount) + /app/src-custom (per-group overrides)
# are merged into /tmp/src before compilation. Custom files take priority, so per-group
# agents can add or override tool files without blocking global updates.
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
COPY <<'ENTRY' /app/entrypoint.sh
#!/bin/bash
set -e
# Two-layer source merge for clean upgrades + per-group customization:
#   /app/src-global  (read-only mount)  — latest global agent-runner source
#   /app/src-custom  (read-write mount) — per-group tool overrides/additions
# Merged into /tmp/src then compiled via tsconfig.build.json (in /app for node_modules).
mkdir -p /tmp/src
if [ -d /app/src-global ]; then
  cp -r /app/src-global/* /tmp/src/
else
  cp -r /app/src/* /tmp/src/
fi
if [ -d /app/src-custom ] && [ "$(ls -A /app/src-custom 2>/dev/null)" ]; then
  cp -r /app/src-custom/* /tmp/src/
fi
# Symlink node_modules and package.json so module resolution works from /tmp/src
ln -sfn /app/node_modules /tmp/node_modules
ln -sfn /app/package.json /tmp/package.json
cd /app && npx tsc -p tsconfig.build.json 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
ENTRY
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
