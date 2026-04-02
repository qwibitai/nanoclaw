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

# Install plugin binaries declared in plugins/binaries.json.
# Each entry is either a direct URL download or a .tgz archive with named binaries to extract.
# This step is a no-op when the array is empty.
COPY plugins/binaries.json /tmp/plugins.json
RUN node -e "\
const fs = require('fs');\
const { execFileSync } = require('child_process');\
const plugins = JSON.parse(fs.readFileSync('/tmp/plugins.json'));\
plugins.forEach((p, index) => {\
  if (!p || !p.name) {\
    throw new Error('Invalid plugin entry: missing name');\
  }\
  if (p.url) {\
    if (!p.dest) {\
      throw new Error('Plugin ' + p.name + ' missing dest for direct download');\
    }\
    console.log('Installing plugin binary: ' + p.name);\
    execFileSync('curl', ['-fsSL', '-o', p.dest, p.url], { stdio: 'inherit' });\
    execFileSync('chmod', ['+x', p.dest], { stdio: 'inherit' });\
  } else if (p.archive) {\
    if (!Array.isArray(p.extract) || p.extract.length === 0) {\
      throw new Error('Plugin ' + p.name + ' missing extract file list for archive');\
    }\
    console.log('Installing plugin archive: ' + p.name);\
    const archivePath = '/tmp/plugin-archive-' + index + '.tgz';\
    execFileSync('curl', ['-fsSL', '-o', archivePath, p.archive], { stdio: 'inherit' });\
    const tarArgs = ['xz', '--strip-components=1', '-C', '/usr/local/bin/'];\
    for (const f of p.extract) { tarArgs.push(f); }\
    execFileSync('tar', tarArgs, { stdio: 'inherit' });\
    const destPaths = p.extract.map(f => '/usr/local/bin/' + f);\
    execFileSync('chmod', ['+x', ...destPaths], { stdio: 'inherit' });\
  }\
});\
"

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Plugin container-init scripts (sourced at container startup before the agent runs)
COPY plugins/ /app/plugins/

# Copy entrypoint script
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
