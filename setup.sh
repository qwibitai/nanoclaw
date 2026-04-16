#!/bin/bash
set -euo pipefail

# setup.sh — Bootstrap script for NanoClaw
# Handles Node.js/npm setup, then hands off to the Node.js setup modules.
# This is the only bash script in the setup flow.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"
AGENT_RUNNER_DIR="$PROJECT_ROOT/container/agent-runner"
AGENT_RUNNER_PACKAGE_JSON="$AGENT_RUNNER_DIR/package.json"
AGENT_RUNNER_INDEX_TS="$AGENT_RUNNER_DIR/src/index.ts"
AGENT_RUNNER_BUN_LOCK="$AGENT_RUNNER_DIR/bun.lock"
AGENT_RUNNER_PACKAGE_LOCK="$AGENT_RUNNER_DIR/package-lock.json"
OPEN_AGENT_SDK_VERSION="0.1.0-alpha.1"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [bootstrap] $*" >> "$LOG_FILE"; }

# --- Platform detection ---

detect_platform() {
  local uname_s
  uname_s=$(uname -s)
  case "$uname_s" in
    Darwin*) PLATFORM="macos" ;;
    Linux*)  PLATFORM="linux" ;;
    *)       PLATFORM="unknown" ;;
  esac

  IS_WSL="false"
  if [ "$PLATFORM" = "linux" ] && [ -f /proc/version ]; then
    if grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null; then
      IS_WSL="true"
    fi
  fi

  IS_ROOT="false"
  if [ "$(id -u)" -eq 0 ]; then
    IS_ROOT="true"
  fi

  log "Platform: $PLATFORM, WSL: $IS_WSL, Root: $IS_ROOT"
}

# --- Node.js check ---

check_node() {
  NODE_OK="false"
  NODE_VERSION="not_found"
  NODE_PATH_FOUND=""

  if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node --version 2>/dev/null | sed 's/^v//')
    NODE_PATH_FOUND=$(command -v node)
    local major
    major=$(echo "$NODE_VERSION" | cut -d. -f1)
    if [ "$major" -ge 20 ] 2>/dev/null; then
      NODE_OK="true"
    fi
    log "Node $NODE_VERSION at $NODE_PATH_FOUND (major=$major, ok=$NODE_OK)"
  else
    log "Node not found"
  fi
}

# --- npm install ---

install_deps() {
  DEPS_OK="false"
  NATIVE_OK="false"

  if [ "$NODE_OK" = "false" ]; then
    log "Skipping npm install — Node not available"
    return
  fi

  cd "$PROJECT_ROOT"

  # npm install with --unsafe-perm if root (needed for native modules)
  local npm_flags=""
  if [ "$IS_ROOT" = "true" ]; then
    npm_flags="--unsafe-perm"
    log "Running as root, using --unsafe-perm"
  fi

  log "Running npm ci $npm_flags"
  if npm ci $npm_flags >> "$LOG_FILE" 2>&1; then
    DEPS_OK="true"
    log "npm install succeeded"
  else
    log "npm install failed"
    return
  fi

  # Verify native module (better-sqlite3)
  log "Verifying native modules"
  if node -e "require('better-sqlite3')" >> "$LOG_FILE" 2>&1; then
    NATIVE_OK="true"
    log "better-sqlite3 loads OK"
  else
    log "better-sqlite3 failed to load"
  fi
}

# --- Build tools check ---

check_build_tools() {
  HAS_BUILD_TOOLS="false"

  if [ "$PLATFORM" = "macos" ]; then
    if xcode-select -p >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  elif [ "$PLATFORM" = "linux" ]; then
    if command -v gcc >/dev/null 2>&1 && command -v make >/dev/null 2>&1; then
      HAS_BUILD_TOOLS="true"
    fi
  fi

  log "Build tools: $HAS_BUILD_TOOLS"
}

# --- Agent-runner migration for open-agent-sdk + Bun ---

migrate_agent_runner() {
  MIGRATION_OK="true"
  MIGRATION_CHANGED="false"
  MIGRATION_LOCK_UPDATED="false"

  if [ "$NODE_OK" = "false" ]; then
    log "Skipping agent-runner migration — Node not available"
    MIGRATION_OK="false"
    return
  fi

  if [ ! -f "$AGENT_RUNNER_PACKAGE_JSON" ] || [ ! -f "$AGENT_RUNNER_INDEX_TS" ]; then
    log "Skipping agent-runner migration — required files not found"
    MIGRATION_OK="false"
    return
  fi

  local import_update_status
  import_update_status=$(node - "$AGENT_RUNNER_INDEX_TS" <<'NODE'
const fs = require('fs');
const filePath = process.argv[2];
const oldImport = 'open-agent-sdk/packages/core/src/index.ts';
const newImport = 'open-agent-sdk';

let source = fs.readFileSync(filePath, 'utf8');
if (!source.includes(oldImport)) {
  process.stdout.write('unchanged');
  process.exit(0);
}

source = source.split(oldImport).join(newImport);
fs.writeFileSync(filePath, source);
process.stdout.write('changed');
NODE
) || {
    log "Failed to update agent-runner import path"
    MIGRATION_OK="false"
    return
  }

  if [ "$import_update_status" = "changed" ]; then
    MIGRATION_CHANGED="true"
    log "Updated agent-runner import path to open-agent-sdk"
  fi

  local package_update_status
  package_update_status=$(node - "$AGENT_RUNNER_PACKAGE_JSON" "$OPEN_AGENT_SDK_VERSION" <<'NODE'
const fs = require('fs');
const packageJsonPath = process.argv[2];
const sdkVersion = process.argv[3];
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

packageJson.dependencies = packageJson.dependencies || {};
let changed = false;

if (packageJson.dependencies['open-agent-sdk'] !== sdkVersion) {
  packageJson.dependencies['open-agent-sdk'] = sdkVersion;
  changed = true;
}

if (packageJson.dependencies['@anthropic-ai/claude-agent-sdk']) {
  delete packageJson.dependencies['@anthropic-ai/claude-agent-sdk'];
  changed = true;
}

if (changed) {
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  process.stdout.write('changed');
} else {
  process.stdout.write('unchanged');
}
NODE
) || {
    log "Failed to update agent-runner package.json"
    MIGRATION_OK="false"
    return
  }

  if [ "$package_update_status" = "changed" ]; then
    MIGRATION_CHANGED="true"
    log "Updated agent-runner dependency to open-agent-sdk@$OPEN_AGENT_SDK_VERSION"
  fi

  if [ -f "$AGENT_RUNNER_PACKAGE_LOCK" ]; then
    rm -f "$AGENT_RUNNER_PACKAGE_LOCK"
    MIGRATION_CHANGED="true"
    log "Removed stale agent-runner package-lock.json"
  fi

  local lock_needs_refresh="false"
  if [ ! -f "$AGENT_RUNNER_BUN_LOCK" ]; then
    lock_needs_refresh="true"
  elif ! grep -q "\"open-agent-sdk\": \"$OPEN_AGENT_SDK_VERSION\"" "$AGENT_RUNNER_BUN_LOCK"; then
    lock_needs_refresh="true"
  elif [ "$MIGRATION_CHANGED" = "true" ]; then
    lock_needs_refresh="true"
  fi

  if [ "$lock_needs_refresh" = "true" ]; then
    log "Refreshing agent-runner bun.lock"
    if command -v bun >/dev/null 2>&1; then
      if (cd "$AGENT_RUNNER_DIR" && bun install) >> "$LOG_FILE" 2>&1; then
        MIGRATION_LOCK_UPDATED="true"
        log "bun.lock refreshed with local bun"
      else
        log "bun install failed while refreshing bun.lock"
        MIGRATION_OK="false"
        return
      fi
    elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      if docker run --rm --user "$(id -u):$(id -g)" -v "$AGENT_RUNNER_DIR:/work" -w /work oven/bun:1 bun install >> "$LOG_FILE" 2>&1; then
        MIGRATION_LOCK_UPDATED="true"
        log "bun.lock refreshed with dockerized bun"
      else
        log "dockerized bun install failed while refreshing bun.lock"
        MIGRATION_OK="false"
        return
      fi
    else
      log "Cannot refresh bun.lock (bun not installed and Docker unavailable)"
      MIGRATION_OK="false"
      return
    fi
  else
    log "agent-runner bun.lock already up-to-date"
  fi
}

# --- Main ---

log "=== Bootstrap started ==="

detect_platform
check_node
install_deps
check_build_tools
migrate_agent_runner

# Emit status block
STATUS="success"
if [ "$NODE_OK" = "false" ]; then
  STATUS="node_missing"
elif [ "$DEPS_OK" = "false" ]; then
  STATUS="deps_failed"
elif [ "$NATIVE_OK" = "false" ]; then
  STATUS="native_failed"
elif [ "$MIGRATION_OK" = "false" ]; then
  STATUS="migration_failed"
fi

cat <<EOF
=== NANOCLAW SETUP: BOOTSTRAP ===
PLATFORM: $PLATFORM
IS_WSL: $IS_WSL
IS_ROOT: $IS_ROOT
NODE_VERSION: $NODE_VERSION
NODE_OK: $NODE_OK
NODE_PATH: ${NODE_PATH_FOUND:-not_found}
DEPS_OK: $DEPS_OK
NATIVE_OK: $NATIVE_OK
HAS_BUILD_TOOLS: $HAS_BUILD_TOOLS
MIGRATION_OK: $MIGRATION_OK
MIGRATION_CHANGED: $MIGRATION_CHANGED
MIGRATION_LOCK_UPDATED: $MIGRATION_LOCK_UPDATED
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

log "=== Bootstrap completed: $STATUS ==="

if [ "$NODE_OK" = "false" ]; then
  exit 2
fi
if [ "$DEPS_OK" = "false" ] || [ "$NATIVE_OK" = "false" ]; then
  exit 1
fi
if [ "$MIGRATION_OK" = "false" ]; then
  exit 1
fi
