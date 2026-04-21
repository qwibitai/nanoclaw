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

# Install agent-browser, claude-code, and MCP servers globally
RUN npm install -g agent-browser @anthropic-ai/claude-code outlook-mcp @notionhq/notion-mcp-server

# Patch outlook-mcp@2.4.2: upstream list.js ignores well-known folder aliases
# (falls back to inbox for folder: "sent"); search.js combines $search with
# $orderby which Graph rejects with HTTP 400; graph-api.js never sets the
# ConsistencyLevel: eventual header, which Graph requires for $search with
# KQL field syntax (from:"...", subject:"..."). See the patch files.
COPY patches/outlook-mcp-list.js /usr/local/lib/node_modules/outlook-mcp/email/list.js
COPY patches/outlook-mcp-search.js /usr/local/lib/node_modules/outlook-mcp/email/search.js
COPY patches/outlook-mcp-graph-api.js /usr/local/lib/node_modules/outlook-mcp/utils/graph-api.js

# Install google-workspace-mcp (Drive, Sheets, Docs) from source
RUN git clone --depth 1 https://github.com/VolksRat71/google-workspace-mcp.git /opt/google-workspace-mcp \
    && cd /opt/google-workspace-mcp && npm install && npm run build

# Copy Granola MCP server (lightweight custom server, no npm package)
COPY patches/granola-mcp-server.js /usr/local/lib/granola-mcp-server.js

# Install Python + Snowflake MCP server (Snowflake-Labs/mcp). Uses a venv to
# keep system Python clean. Pinned snowflake-labs-mcp to avoid surprise
# upgrades breaking the agent's tool calls.
RUN apt-get update && apt-get install -y python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/snowflake-mcp-venv \
    && /opt/snowflake-mcp-venv/bin/pip install --no-cache-dir snowflake-labs-mcp

# Tools config driving which Snowflake capabilities the MCP exposes. Mounted
# as read-only so the agent can't mutate it.
COPY patches/snowflake-tools-config.yaml /etc/snowflake-tools-config.yaml

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
