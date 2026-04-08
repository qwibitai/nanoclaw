#!/bin/bash
# Write git SHA to a file for the agent to read
# Called by npm prebuild script

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
GIT_SHA_SHORT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > VERSION << EOF
sha=${GIT_SHA}
short=${GIT_SHA_SHORT}
built=${BUILD_TIME}
EOF

echo "Wrote VERSION: ${GIT_SHA_SHORT}"