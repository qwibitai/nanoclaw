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

# Chromium wrapper: reset XDG_CONFIG_HOME and XDG_CACHE_HOME to writable temp
# dirs before launching. The main container mounts the project root read-only
# at /workspace/project, and Claude Code inherits/sets XDG_CONFIG_HOME to that
# path. Chromium does an early CHECK on XDG_CONFIG_HOME writability (before
# --user-data-dir is even parsed) and SIGTRAPs if it's read-only.
RUN printf '#!/bin/sh\nexport XDG_CONFIG_HOME=/tmp/chromium-xdg-config\nexport XDG_CACHE_HOME=/tmp/chromium-xdg-cache\nexec /usr/bin/chromium "$@"\n' \
    > /usr/local/bin/chromium-wrapper && chmod +x /usr/local/bin/chromium-wrapper

# Set Chromium path for agent-browser (use wrapper to fix XDG env)
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium-wrapper
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/local/bin/chromium-wrapper

# Install agent-browser, claude-code, and Google Workspace CLI globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @googleworkspace/cli

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
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
