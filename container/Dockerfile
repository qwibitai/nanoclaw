# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    # Browser automation
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
    # Core tools
    curl \
    wget \
    git \
    jq \
    # Python (for scripts Adam might write)
    python3 \
    python3-pip \
    # Networking & APIs
    dnsutils \
    iputils-ping \
    openssl \
    ca-certificates \
    # File processing
    zip \
    unzip \
    imagemagick \
    ffmpeg \
    # Text processing

    gawk \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Make pre-installed packages available from any working directory
# Trusted packages first — agent-installed packages cannot shadow built-in ones
ENV NODE_PATH=/app/node_modules:/workspace/group/.packages/node_modules

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code \
    typescript \
    tsx \
    nodemon

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Pre-install useful packages for agent scripts
# These are available via: import('axios') or require() in Adam's scripts
RUN npm install \
    axios \
    cheerio \
    nodemailer \
    csv-parse \
    csv-stringify \
    marked \
    turndown \
    sharp \
    pdf-parse \
    rss-parser \
    date-fns \
    lodash \
    stripe \
    openai \
    dotenv

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
RUN mkdir -p /home/node/.claude/debug && chown -R node:node /workspace /home/node/.claude && chmod 777 /home/node

# Block postinstall scripts for runtime agent installs (supply chain safety)
# Placed AFTER build-time installs so sharp/native packages build correctly
ENV npm_config_ignore_scripts=true

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
