# NanoClaw Agent Container
# Runs Open Agent SDK in isolated Linux VM with browser automation

FROM oven/bun:1

ARG OPEN_AGENT_SDK_FORK_URL=https://github.com/shin902/open-agent-sdk.git
ARG OPEN_AGENT_SDK_FORK_REF=main

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
    npm \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser globally
RUN bun add -g agent-browser --trust

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package.json agent-runner/bun.lock ./

# Clone forked open-agent-sdk so file: dependency resolves reliably under Bun.
RUN git clone --depth 1 --branch "${OPEN_AGENT_SDK_FORK_REF}" "${OPEN_AGENT_SDK_FORK_URL}" /app/.open-agent-sdk-fork \
    && test -f /app/.open-agent-sdk-fork/packages/core/package.json \
    && cd /app/.open-agent-sdk-fork/packages/core \
    && bun install \
    && bun run build \
    && PACK_FILE="$(npm pack --silent)" \
    && mv "$PACK_FILE" /app/.open-agent-sdk-fork/open-agent-sdk-fork.tgz \
    && test -f /app/.open-agent-sdk-fork/open-agent-sdk-fork.tgz \
    && rm -rf /app/.open-agent-sdk-fork/.git

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
