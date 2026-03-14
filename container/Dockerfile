# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation
# and agentsh security enforcement (policy engine, DLP, threat feeds)

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

# ---------------------------------------------------------------------------
# Entrypoint scripts — created BEFORE shim install to avoid agentsh
# intercepting /bin/sh during docker build (node image links sh -> bash)
# ---------------------------------------------------------------------------

# Stage 1: /bin/sh — configures agentsh proxy upstream before shim activates
RUN printf '#!/bin/dash\nset -e\n# Configure agentsh DLP proxy upstream (credential proxy on host)\nif [ -n "$NANOCLAW_CREDENTIAL_PROXY_URL" ]; then\n  sed -i "s|CREDENTIAL_PROXY_UPSTREAM|${NANOCLAW_CREDENTIAL_PROXY_URL}|" /etc/agentsh/config.yaml\nfi\n# Hand off to bash (goes through agentsh shim for policy enforcement)\nexec /bin/bash /app/main-entrypoint.sh\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Stage 2: /bin/bash (shimmed at runtime) — compiles agent-runner and starts agent
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/main-entrypoint.sh && chmod +x /app/main-entrypoint.sh

# ---------------------------------------------------------------------------
# agentsh: Security enforcement for container agents
# Install AFTER all npm/build commands and entrypoint creation
# ---------------------------------------------------------------------------

ARG AGENTSH_TAG=v0.15.3
RUN set -eux; \
    version="${AGENTSH_TAG#v}"; \
    arch="$(dpkg --print-architecture)"; \
    deb="agentsh_${version}_linux_${arch}.deb"; \
    url="https://github.com/canyonroad/agentsh/releases/download/${AGENTSH_TAG}/${deb}"; \
    curl -fsSL -L "${url}" -o /tmp/agentsh.deb; \
    dpkg -i /tmp/agentsh.deb; \
    rm -f /tmp/agentsh.deb

# Copy agentsh configuration and security policy
COPY agentsh/ /etc/agentsh/

# Create agentsh data directories (writable by node user)
RUN mkdir -p /home/node/.agentsh/logs /home/node/.agentsh/data \
    /home/node/.agentsh/sessions /home/node/.agentsh/threat-feeds \
    && chown -R node:node /home/node/.agentsh /etc/agentsh

# Install shell shim LAST — replaces /bin/bash with agentsh policy gateway.
# All subsequent bash invocations (at runtime) route through the policy engine.
# No more RUN commands after this point to avoid shim triggering during build.
RUN agentsh shim install-shell \
    --root / \
    --shim /usr/bin/agentsh-shell-shim \
    --bash \
    --i-understand-this-modifies-the-host

# agentsh environment
ENV AGENTSH_CONFIG=/etc/agentsh/config.yaml
ENV AGENTSH_SHIM_FORCE=1
ENV AGENTSH_POLICY_NAME=nanoclaw

# Set ownership to node user (non-root) for writable directories
# Uses /bin/sh (dash, not shimmed) since this is a build step
SHELL ["/bin/dash", "-c"]
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
# Uses /bin/dash shebang to bypass agentsh shim for init, then execs /bin/bash
ENTRYPOINT ["/app/entrypoint.sh"]
