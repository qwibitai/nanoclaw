#!/bin/bash
set -e

# Add skill executables to PATH (each skill dir may contain CLI tools)
for skill_dir in /home/node/.claude/skills/*/; do
  [ -d "$skill_dir" ] && export PATH="$skill_dir:$PATH"
done

# If GITHUB_TOKEN is set (dev cases), configure git to use it for HTTPS auth
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global credential.helper \
    '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'
  git config --global user.email "nanoclaw-dev@garsson.io"
  git config --global user.name "NanoClaw Dev Agent"
fi

# Use pre-compiled dist/ (mounted from host or built into image).
# No runtime tsc — the host compiles once via `npm run build` (kaizen #123).
cat > /tmp/input.json
node /app/dist/index.js < /tmp/input.json
