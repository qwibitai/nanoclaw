#!/bin/sh
set -e

echo "=== NanoClaw startup ==="

# Build agent image if not present on host
if ! docker image inspect nanoclaw-agent:latest > /dev/null 2>&1; then
    echo "Building nanoclaw-agent image..."
    cd /app/container && sh build.sh
    cd /app
else
    echo "nanoclaw-agent image found, skipping build."
fi

# Pre-create persistent data directory structure so volume mounts
# don't start empty and cause runtime errors on first boot
mkdir -p \
    /app/data/sessions \
    /app/data/env \
    /app/data/ipc \
    /app/logs \
    /app/store

chown -R 1000:1000 /app/data/sessions

# Seed a minimal .claude.json for each existing group session directory
# so claude-code considers itself logged in without needing the host's real token file.
for session_dir in /app/data/sessions/*/; do
    [ -d "$session_dir" ] || continue
    claude_json="$session_dir.claude.json"
    if [ ! -f "$claude_json" ]; then
        cat > "$claude_json" <<'EOF'
{
  "hasCompletedOnboarding": true,
  "lastOnboardingVersion": "2.1.76",
  "oauthAccount": {
    "accountUuid": "00000000-0000-0000-0000-000000000000",
    "emailAddress": "agent@nanoclaw.local",
    "organizationUuid": "00000000-0000-0000-0000-000000000000",
    "displayName": "NanoClaw Agent",
    "organizationRole": "admin",
    "organizationName": "NanoClaw"
  }
}
EOF
        chown 1000:1000 "$claude_json"
        echo "Seeded .claude.json for $session_dir"
    fi
done

echo "Starting NanoClaw..."
exec node dist/index.js
