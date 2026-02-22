FROM node:22-slim

RUN apt-get update && apt-get install -y curl git \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# OpenCode CLI (npm package: opencode-ai)
RUN npm install -g opencode-ai

# Build worker runner (pre-compiled — no runtime recompilation)
WORKDIR /app
COPY runner/package*.json ./
RUN npm install
COPY runner/ ./
RUN npm run build

# OpenCode config via OPENCODE_CONFIG_CONTENT env var (highest precedence —
# overrides any project-level opencode.json per OpenCode config precedence docs).
# Uses kimi-k2.5-free by default; WORKER_MODEL env var allows override at runtime.
# Instructions point to /workspace/group/CLAUDE.md so worker identity loads automatically.
ENV OPENCODE_CONFIG_CONTENT='{"model":"opencode/kimi-k2.5-free","autoupdate":false,"instructions":{"/workspace/group/CLAUDE.md":"always"}}'

RUN mkdir -p /workspace/group /workspace/global /workspace/extra \
             /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Entrypoint: read JSON from stdin → node runner → emit output markers
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\nrm -f /tmp/input.json\n' \
    > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

RUN chown -R node:node /workspace && chmod 777 /home/node
USER node
WORKDIR /workspace/group
ENTRYPOINT ["/app/entrypoint.sh"]
