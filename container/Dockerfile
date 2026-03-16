# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation
# Offline build: uses nanoclaw-base image imported from host filesystem

FROM nanoclaw-base:latest

# Ensure Node 22 is on the PATH (imported from host at /opt/node22)
ENV PATH="/opt/node22/bin:$PATH"

# Playwright chromium path (copied from host cache)
ENV AGENT_BROWSER_EXECUTABLE_PATH=/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Ensure node user exists
RUN id -u node 2>/dev/null || useradd -m -s /bin/bash node

# Create app directory and copy agent-runner
WORKDIR /app
COPY agent-runner/ ./

# Install dependencies and pre-compile TypeScript at build time
RUN npm ci --ignore-scripts || npm install
RUN npx tsc --outDir /app/dist && \
    ln -s /app/node_modules /app/dist/node_modules && \
    find /app/src -type f -name '*.ts' -exec md5sum {} + | sort | md5sum | cut -d' ' -f1 > /app/dist/.src-hash

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script — uses pre-compiled dist, recompiles only on real source changes
RUN printf '#!/bin/bash\nset -e\ntrap '\''echo "[entrypoint] SIGTERM received at $(date -u +%%Y-%%m-%%dT%%H:%%M:%%S.%%3NZ) (PID $$)" >&2'\'' TERM\n\nBUILD_HASH=$(cat /app/dist/.src-hash 2>/dev/null || echo "")\nCURRENT_HASH=$(find /app/src -type f -name "*.ts" -exec md5sum {} + 2>/dev/null | sort | md5sum | cut -d" " -f1)\nif [ -z "$BUILD_HASH" ] || [ "$BUILD_HASH" != "$CURRENT_HASH" ]; then\n  echo "[entrypoint] Agent-runner source modified, recompiling..." >&2\n  cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\n  ln -s /app/node_modules /tmp/dist/node_modules\nelse\n  ln -sf /app/dist /tmp/dist\nfi\n\nif [ ! -f /tmp/input.json ]; then\n  cat > /tmp/input.json\nfi\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN mkdir -p /tmp && chmod 1777 /tmp && mkdir -p /home/node && chown -R node:node /workspace /home/node && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
