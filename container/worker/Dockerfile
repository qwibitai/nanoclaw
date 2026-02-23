FROM node:22

# Buildkit DNS for apt repositories is flaky on this host. Use a base image that
# already includes git/curl and avoid apt entirely for worker image builds.
RUN git --version && curl --version > /dev/null

# OpenCode CLI bundle is prepared outside buildkit via container/worker/build.sh
# and copied in as a deterministic artifact.
COPY vendor/opencode-ai-node_modules.tgz /tmp/opencode-ai-node_modules.tgz
RUN mkdir -p /usr/local/lib/node_modules \
    && tar -xzf /tmp/opencode-ai-node_modules.tgz -C /usr/local/lib/node_modules \
    && ln -sf ../lib/node_modules/opencode-ai/bin/opencode /usr/local/bin/opencode \
    && chmod +x /usr/local/lib/node_modules/opencode-ai/bin/opencode \
    && opencode --version > /dev/null

# Worker runner (plain Node.js, no container-time dependency install)
WORKDIR /app
COPY runner/index.js /app/index.js

# OpenCode config via OPENCODE_CONFIG_CONTENT env var (highest precedence).
# Keep a pinned free model; load group CLAUDE.md and skill path deterministically.
ENV OPENCODE_CONFIG_CONTENT='{"model":"opencode/minimax-m2.5-free","autoupdate":false,"instructions":["/workspace/group/CLAUDE.md"],"skills":{"paths":["/home/node/.claude/skills"]},"mcp":{"deepwiki":{"type":"remote","enabled":true,"url":"https://mcp.deepwiki.com/mcp"},"context7":{"type":"local","enabled":true,"command":["npx","-y","@upstash/context7-mcp"]},"token-efficient":{"type":"local","enabled":true,"command":["node","/workspace/mcp-servers/token-efficient-mcp/dist/index.js"]},"chrome-devtools":{"type":"local","enabled":true,"command":["npx","-y","chrome-devtools-mcp","--channel=beta"]}}}'
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
