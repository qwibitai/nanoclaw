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
    && /opt/snow-venv/bin/pip install snowflake-cli==3.16.0 \
    && ln -s /opt/snow-venv/bin/snow /usr/local/bin/snow \
    && rm -rf /var/lib/apt/lists/*

# Install dbt-core + dbt-snowflake adapter
RUN python3 -m venv /opt/dbt-venv \
    && /opt/dbt-venv/bin/pip install dbt-core==1.11.7 dbt-snowflake==1.11.3 \
    && ln -s /opt/dbt-venv/bin/dbt /usr/local/bin/dbt \
    && rm -rf /var/lib/apt/lists/*

# Install Google Workspace MCP server (Drive, Sheets, Slides, Docs)
RUN python3 -m venv /opt/gwmcp-venv \
    && /opt/gwmcp-venv/bin/pip install workspace-mcp \
    && ln -s /opt/gwmcp-venv/bin/workspace-mcp /usr/local/bin/workspace-mcp

# Install Python visualization libraries (matplotlib, seaborn, plotly + kaleido for PNG export)
# Installed to system python — agents use `python3` directly
RUN pip install --break-system-packages matplotlib seaborn plotly kaleido

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install bun (needed by plugin hooks that use TypeScript)
RUN apt-get update && apt-get install -y unzip \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser, claude-code, MCP servers, and Mermaid CLI globally.
# Pre-installing MCP servers avoids npx downloading them at runtime,
# which is slow and intermittently fails (causing "no Gmail MCP tools" errors).
# Mermaid CLI uses system Chromium (PUPPETEER_SKIP_DOWNLOAD avoids 300MB download).
# Pinned versions — build.sh checks for updates automatically.
RUN PUPPETEER_SKIP_DOWNLOAD=true npm install -g \
    agent-browser@0.22.1 \
    @anthropic-ai/claude-code \
    @gongrzhe/server-gmail-autoauth-mcp@1.1.11 \
    @cocal/google-calendar-mcp@2.6.1 \
    @mermaid-js/mermaid-cli

# Install PostgreSQL client, Redis CLI, and Google Cloud CLI
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
       | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
       > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       postgresql-client \
       redis-tools \
       google-cloud-cli \
    && rm -rf /var/lib/apt/lists/* && apt-get clean

# Install AWS CLI v2
RUN ARCH=$(uname -m) \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscli.zip /tmp/aws

# Install Render CLI, Railway CLI, and Supabase CLI
ARG RENDER_VERSION=2.15.0
ARG RAILWAY_VERSION=4.33.0
ARG SUPABASE_VERSION=2.78.1
RUN DPKG_ARCH=$(dpkg --print-architecture) && UARCH=$(uname -m) \
    && curl -fsSL "https://github.com/render-oss/cli/releases/download/v${RENDER_VERSION}/cli_${RENDER_VERSION}_linux_${DPKG_ARCH}.zip" \
       -o /tmp/render.zip \
    && unzip -q /tmp/render.zip -d /tmp/render \
    && mv /tmp/render/cli_v${RENDER_VERSION} /usr/local/bin/render \
    && chmod +x /usr/local/bin/render \
    && curl -fsSL "https://github.com/railwayapp/cli/releases/download/v${RAILWAY_VERSION}/railway-v${RAILWAY_VERSION}-${UARCH}-unknown-linux-musl.tar.gz" \
       | tar xz -C /usr/local/bin railway \
    && chmod +x /usr/local/bin/railway \
    && curl -fsSL "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_${SUPABASE_VERSION}_linux_${DPKG_ARCH}.deb" \
       -o /tmp/supabase.deb \
    && dpkg -i /tmp/supabase.deb \
    && rm -rf /tmp/render.zip /tmp/render /tmp/supabase.deb

# Install Cortex Code (Snowflake AI coding CLI)
RUN HOME=/home/node curl -fsSL https://ai.snowflake.com/static/cc-scripts/install.sh \
       | HOME=/home/node DOCKER_ENV=1 bash \
    && chown -R node:node /home/node/.local
ENV PATH="/home/node/.local/bin:${PATH}"

# Puppeteer config for Mermaid CLI (use system Chromium, no sandbox for non-root)
COPY puppeteer-config.json /app/puppeteer-config.json

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
