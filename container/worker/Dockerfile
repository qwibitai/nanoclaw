FROM node:22

# Browser testing in worker containers requires an in-container Chromium runtime.
RUN set -eux; \
    ok=0; \
    for i in 1 2 3; do \
      if apt-get update; then ok=1; break; fi; \
      sleep $((i * 2)); \
    done; \
    if [ "${ok}" -ne 1 ]; then \
      echo "apt-get update failed after retries" >&2; \
      exit 1; \
    fi; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji; \
    rm -rf /var/lib/apt/lists/*

# OpenCode + MCP binaries are prepared outside buildkit via container/worker/build.sh
# and copied in as deterministic artifacts.
COPY vendor/opencode-ai-node_modules.tgz /tmp/opencode-ai-node_modules.tgz
RUN mkdir -p /usr/local/lib/node_modules \
    && tar -xzf /tmp/opencode-ai-node_modules.tgz -C /usr/local/lib/node_modules \
    && ln -sf ../lib/node_modules/opencode-ai/bin/opencode /usr/local/bin/opencode \
    && ln -sf ../lib/node_modules/chrome-devtools-mcp/build/src/index.js /usr/local/bin/chrome-devtools-mcp \
    && ln -sf ../lib/node_modules/@upstash/context7-mcp/dist/index.js /usr/local/bin/context7-mcp \
    && ln -sf ../lib/node_modules/mcp-remote/dist/proxy.js /usr/local/bin/mcp-remote \
    && chmod +x /usr/local/lib/node_modules/opencode-ai/bin/opencode \
    && chmod +x /usr/local/lib/node_modules/chrome-devtools-mcp/build/src/index.js \
    && chmod +x /usr/local/lib/node_modules/@upstash/context7-mcp/dist/index.js \
    && chmod +x /usr/local/lib/node_modules/mcp-remote/dist/proxy.js \
    && opencode --version > /dev/null

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Worker runner (plain Node.js, no container-time dependency install)
WORKDIR /app
COPY runner/index.js /app/index.js

# OpenCode config via OPENCODE_CONFIG_CONTENT env var (highest precedence).
# Keep a pinned free model; load group CLAUDE.md and skill path deterministically.
ENV OPENCODE_CONFIG_CONTENT='{"model":"opencode/minimax-m2.5-free","autoupdate":false,"instructions":["/workspace/group/CLAUDE.md"],"skills":{"paths":["/home/node/.claude/skills"]},"mcp":{"deepwiki":{"type":"local","enabled":true,"command":["mcp-remote","https://mcp.deepwiki.com/mcp","--transport","streamable-http"]},"context7":{"type":"local","enabled":true,"command":["context7-mcp"]},"token-efficient":{"type":"local","enabled":true,"command":["node","/workspace/mcp-servers/token-efficient-mcp/dist/index.js"]},"chrome-devtools":{"type":"local","enabled":true,"command":["chrome-devtools-mcp","--headless","--isolated","--executablePath","/usr/bin/chromium","--chromeArg=--disable-dev-shm-usage","--chromeArg=--no-sandbox"]}}}'
ENV WORKER_GIT_NAME='Andy (openclaw-gurusharan)'
ENV WORKER_GIT_EMAIL='openclaw-gurusharan@users.noreply.github.com'

RUN mkdir -p /workspace/group /workspace/global /workspace/extra \
             /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input \
             /home/node/.claude/skills /home/node/.claude/rules

# Entrypoint: read JSON from stdin → node runner → emit output markers
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nnode /app/index.js < /tmp/input.json\nrm -f /tmp/input.json\n' \
    > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

RUN chown -R node:node /workspace && chmod 777 /home/node
USER node
WORKDIR /workspace/group
ENTRYPOINT ["/app/entrypoint.sh"]
