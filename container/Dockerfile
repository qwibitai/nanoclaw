# NanoClaw Agent Container
# Runs Open Agent SDK in isolated Linux VM with browser automation

FROM oven/bun:1

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
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser globally
RUN bun add -g agent-browser --trust

# Create app directory
WORKDIR /app

# Copy package files and pre-built open-agent-sdk tarball (built by setup.sh on host).
# Using the host-built tarball ensures the integrity hash in bun.lock matches.
COPY agent-runner/package.json agent-runner/bun.lock ./
COPY agent-runner/.open-agent-sdk-fork/open-agent-sdk-fork.tgz ./.open-agent-sdk-fork/open-agent-sdk-fork.tgz

# Install dependencies
RUN bun install --frozen-lockfile \
    && rm -rf /app/node_modules/open-agent-sdk/node_modules

# Copy source code
COPY agent-runner/src ./src
COPY agent-runner/tsconfig.json ./tsconfig.json

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are provider-dependent:
#   - Anthropic / OpenAI: injected at runtime by the host credential proxy (not passed directly).
#   - Gemini / Codex: injected directly as env vars (GEMINI_API_KEY / OAS_CODEX_OAUTH_JSON)
#     because these providers are not routed through the proxy.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app\ncat > /tmp/input.json\nbun run /app/src/index.ts < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
