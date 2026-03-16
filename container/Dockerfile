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

# Create app directory and copy pre-built agent-runner (built on host)
WORKDIR /app
COPY agent-runner/ ./

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ntrap '\''echo "[entrypoint] SIGTERM received at $(date -u +%%Y-%%m-%%dT%%H:%%M:%%S.%%3NZ) (PID $$)" >&2'\'' TERM\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\nif [ ! -f /tmp/input.json ]; then\n  cat > /tmp/input.json\nfi\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN mkdir -p /tmp && chmod 1777 /tmp && mkdir -p /home/node && chown -R node:node /workspace /home/node && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
