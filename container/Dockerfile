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
    jq \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install Snowflake CLI (snow)
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv \
    && python3 -m venv /opt/snow-venv \
    && /opt/snow-venv/bin/pip install snowflake-cli==3.15.0 \
    && ln -s /opt/snow-venv/bin/snow /usr/local/bin/snow \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install bun (needed by plugin hooks that use TypeScript)
RUN apt-get update && apt-get install -y unzip \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser, claude-code, and MCP server packages globally.
# Pre-installing MCP servers avoids npx downloading them at runtime,
# which is slow and intermittently fails (causing "no Gmail MCP tools" errors).
# Pinned versions — build.sh checks for updates automatically.
RUN npm install -g \
    agent-browser@0.17.1 \
    @anthropic-ai/claude-code \
    @gongrzhe/server-gmail-autoauth-mcp@1.1.11 \
    @cocal/google-calendar-mcp@2.6.1

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
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Claude Code user settings (applied via settingSources: ['user'])
RUN mkdir -p /home/node/.claude && \
    echo '{"includeCoAuthoredBy": false}' > /home/node/.claude/settings.json && \
    chown -R node:node /home/node/.claude

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
