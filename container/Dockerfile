# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Firefox + X11 + Audio support
RUN apt-get update && apt-get install -y \
    firefox-esr \
    fonts-liberation \
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
    libwayland-client0 \
    libwayland-cursor0 \
    libwayland-egl1 \
    libxkbcommon0 \
    pulseaudio \
    curl \
    git \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Pre-install Widevine CDM for Firefox DRM support (Netflix, etc.)
RUN mkdir -p /opt/widevine && \
    curl -L https://dl.google.com/widevine-cdm/4.10.2710.0-linux-x64.zip -o /tmp/widevine.zip && \
    unzip /tmp/widevine.zip -d /opt/widevine && \
    rm /tmp/widevine.zip && \
    chmod -R 755 /opt/widevine

ENV MOZ_GMP_PATH=/opt/widevine

# Install @playwright/mcp (provides `playwright-mcp` binary) and claude-code globally
RUN npm install -g @playwright/mcp @anthropic-ai/claude-code

# Install Firefox browser using the exact playwright version bundled with @playwright/mcp.
# This ensures the browser revision aligns with what playwright-mcp expects at runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN PW_CLI=$(find /usr/local/lib/node_modules -name "cli.js" -path "*/playwright/cli.js" 2>/dev/null | head -1) && \
    [ -n "$PW_CLI" ] && node "$PW_CLI" install --with-deps firefox

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
# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it
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
