#!/usr/bin/env bash
set -euo pipefail

# Fetch upstream NanoClaw and extract to a temp directory.
# Outputs a structured status block for machine parsing.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$PROJECT_ROOT"

# Determine the correct remote
REMOTE=""
if git remote get-url upstream &>/dev/null; then
  REMOTE="upstream"
elif git remote get-url origin &>/dev/null; then
  ORIGIN_URL=$(git remote get-url origin)
  if echo "$ORIGIN_URL" | grep -q "qwibitai/nanoclaw"; then
    REMOTE="origin"
  fi
fi

if [ -z "$REMOTE" ]; then
  echo "No upstream remote found. Adding upstream → https://github.com/qwibitai/nanoclaw.git"
  git remote add upstream https://github.com/qwibitai/nanoclaw.git
  REMOTE="upstream"
fi

echo "Fetching from $REMOTE..."
if ! git fetch "$REMOTE" main 2>&1; then
  echo "<<< STATUS"
  echo "STATUS=error"
  echo "ERROR=Failed to fetch from $REMOTE"
  echo "STATUS >>>"
  exit 1
fi

# Get current version from local package.json
CURRENT_VERSION="unknown"
if [ -f package.json ]; then
  CURRENT_VERSION=$(node -e "console.log(require('./package.json').version || 'unknown')")
fi

# Create temp dir and extract only the paths the skills engine tracks.
# Read BASE_INCLUDES from the single source of truth in skills-engine/constants.ts,
# plus always include migrations/ for the migration runner.
TEMP_DIR=$(mktemp -d /tmp/nanoclaw-update-XXXX)
trap 'rm -rf "$TEMP_DIR"' ERR
echo "Extracting $REMOTE/main to $TEMP_DIR..."

CANDIDATES=$(node -e "
  const fs = require('fs');
  const src = fs.readFileSync('skills-engine/constants.ts', 'utf-8');
  const m = src.match(/BASE_INCLUDES\s*=\s*\[([^\]]+)\]/);
  if (!m) { console.error('Cannot parse BASE_INCLUDES'); process.exit(1); }
  const paths = m[1].match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
  paths.push('migrations/');
  console.log(paths.join(' '));
")

# Filter to paths that actually exist in the upstream tree.
# git archive errors if a path doesn't exist, so we check first.
PATHS=""
for candidate in $CANDIDATES; do
  if [ -n "$(git ls-tree --name-only "$REMOTE/main" "$candidate" 2>/dev/null)" ]; then
    PATHS="$PATHS $candidate"
  fi
done

git archive "$REMOTE/main" -- $PATHS | tar -x -C "$TEMP_DIR"

# Get new version from extracted package.json
NEW_VERSION="unknown"
if [ -f "$TEMP_DIR/package.json" ]; then
  NEW_VERSION=$(node -e "console.log(require('$TEMP_DIR/package.json').version || 'unknown')")
fi

echo ""
echo "<<< STATUS"
echo "TEMP_DIR=$TEMP_DIR"
echo "REMOTE=$REMOTE"
echo "CURRENT_VERSION=$CURRENT_VERSION"
echo "NEW_VERSION=$NEW_VERSION"
echo "STATUS=success"
echo "STATUS >>>"
