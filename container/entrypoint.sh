#!/bin/bash
set -euo pipefail

# Git memory limits are baked into the image (Dockerfile).
# Agent-runner is pre-compiled at image build time (/app/dist/).

# Shadow secret files so the agent cannot read host credentials (bot tokens,
# API keys). The project root is mounted read-only at /workspace/project/
# and contains .env + data/env/env with all tokens. Without this, subagents
# can curl the Telegram API directly, bypassing MCP and all logging.
for secret_file in /workspace/project/.env /workspace/project/data/env/env; do
  if [ -f "$secret_file" ] 2>/dev/null; then
    mount --bind /dev/null "$secret_file" 2>/dev/null || true
  fi
done

# Wire tessl rules chain into workspace (first-time setup for new groups).
# .tessl/ and skills/ are populated host-side by container-runner.
# May fail on read-only filesystems (untrusted groups) — non-fatal.
if [ -w /workspace/group ]; then
  if [ -d /home/node/.claude/.tessl ] && [ ! -d /workspace/group/.tessl ]; then
    cp -rL /home/node/.claude/.tessl /workspace/group/.tessl
    echo "[entrypoint] Copied .tessl to workspace" >&2
  fi
  if [ -f /home/node/.claude/.tessl/RULES.md ] && [ ! -f /workspace/group/AGENTS.md ]; then
    cat > /workspace/group/AGENTS.md << 'AGENTS_EOF'


# Agent Rules <!-- managed by orchestrator -->

@.tessl/RULES.md follow the [instructions](.tessl/RULES.md)
AGENTS_EOF
    echo "[entrypoint] Created AGENTS.md" >&2
  fi
fi

# Read container input from stdin and run the agent
cat > /tmp/input.json
node /app/dist/index.js < /tmp/input.json
