# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM oven/bun:slim

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
RUN bun install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package.json agent-runner/bun.lock* ./

# Install dependencies
RUN bun install

# Copy source code
COPY agent-runner/ ./

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Sources env from mounted /workspace/env-dir/env if it exists (workaround for Apple Container -i bug)
# Stdin is buffered to /tmp then piped (Apple Container requires EOF to flush stdin pipe)
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# No build step needed — Bun runs TypeScript directly
RUN printf '#!/bin/bash\nset -e\n[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)\nif [ -n "$GITHUB_TOKEN" ]; then\n  gh auth setup-git 2>/dev/null || true\n  git config --global user.name "${GIT_AUTHOR_NAME:-NanoClaw Agent}"\n  git config --global user.email "nanoclaw@users.noreply.github.com"\nfi\ncat > /tmp/input.json\nbun /app/src/index.ts < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to bun user (non-root) for writable directories
RUN chown -R bun:bun /workspace && chmod 777 /home/bun

# Switch to non-root user (required for --dangerously-skip-permissions)
USER bun

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
