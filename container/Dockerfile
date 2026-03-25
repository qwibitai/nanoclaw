# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM
# Service Bot mode: SSH-based tools, no browser

FROM node:22-slim

# Install system dependencies
# - openssh-client: Service Bot tools SSH to managed hosts
# - curl/git: needed for git ops and API calls
# - No Chromium: browser disabled (Level 0) to reduce attack surface
RUN apt-get update && apt-get install -y \
    openssh-client \
    curl \
    git \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install claude-code globally (no agent-browser — browser disabled)
RUN npm install -g @anthropic-ai/claude-code @aisuite/chub

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

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# Create entrypoint script
# - Dynamic uid mapping: adds current uid to /etc/passwd if missing (needed for SSH)
# - Container input (prompt, group info) is passed via stdin JSON.
# - Credentials are injected by the host's credential proxy — never passed here.
# - Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\n# Dynamic uid mapping for SSH (container may run as host uid != 1000)\nif ! getent passwd "$(id -u)" >/dev/null 2>&1; then\n  echo "nanoclaw:x:$(id -u):$(id -g):NanoClaw Agent:/home/node:/bin/bash" >> /etc/passwd 2>/dev/null || true\nfi\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Make /etc/passwd writable by all so dynamic uid mapping works at runtime
RUN chmod 666 /etc/passwd

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
