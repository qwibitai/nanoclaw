# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation
#
# Cache strategy: layers are ordered least-frequently-changed to most-frequently-changed.
# When adding dependencies, ADD a new RUN layer at the latest valid position — do NOT
# modify existing heavy layers (that invalidates all downstream cache). The CI job uses
# BuildKit with GitHub Actions cache; preserving upper layers saves minutes per PR.
#
# Layer change frequency (top = rarely, bottom = often):
#   1. Base image (node:22-slim)
#   2. System packages (chromium, fonts, gh CLI)       ~500MB, changes ~never
#   3. Global npm packages (agent-browser, claude-code) ~150MB, changes rarely
#   4. Python packages (Pillow, pymupdf, pikepdf)       ~100MB, changes occasionally
#   5. agent-runner package.json + npm install           ~50MB,  changes when deps change
#   6. agent-runner source + build                       small,  changes every src/ PR

FROM node:22-slim

# System dependencies (Chromium, git, gh CLI)
# This is the heaviest layer — do NOT modify it. Add new system deps as a separate
# RUN layer below (see "Vertical-specific system deps" comment).
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
    poppler-utils \
    ghostscript \
    python3 \
    python3-pip \
    curl \
    git \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Vertical-specific system deps: add new RUN layers here (don't modify the layer above).

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Global npm packages — core infrastructure, changes rarely.
# Pin exact versions to stabilize Docker layer cache (kaizen #123).
# To update: check `npm view <pkg> version`, update here, rebuild.
RUN npm install -g agent-browser@0.21.2 @anthropic-ai/claude-code@2.1.79

# Python packages for preflight tools — vertical-specific, changes more often than globals
RUN pip3 install --no-cache-dir --break-system-packages Pillow>=10.0 pymupdf>=1.24.0 pikepdf>=9.0

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

# Copy entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Anthropic credentials are injected by the host's credential proxy — never passed here.
# GitHub credentials are passed as env vars for dev cases only (see container-runner.ts).
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
