#!/usr/bin/env bash
#
# Install the Signal adapter in an already-running NanoClaw checkout.
# Non-interactive — the operator-facing "install signal-cli" + QR scan
# live in setup/channels/signal.ts. This script only:
#
#   1. Fetches src/channels/signal.ts + signal.test.ts from the channels
#      branch.
#   2. Appends the self-registration import to src/channels/index.ts.
#   3. Installs qrcode (for setup-flow QR rendering — adapter itself has
#      no npm deps).
#   4. Builds.
#
# SIGNAL_ACCOUNT is persisted separately by the driver once signal-cli
# link has produced a number; that keeps this script idempotent and
# re-runnable without re-auth.
#
# Emits exactly one status block on stdout (ADD_SIGNAL) at the end. All
# chatty progress goes to stderr so setup:auto's raw-log capture sees
# the full story without cluttering the final block for the parser.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with .claude/skills/add-signal/SKILL.md.
QRCODE_VERSION="qrcode@1.5.4"
QRCODE_TYPES_VERSION="@types/qrcode@1.5.6"

# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

emit_status() {
  local status=$1 error=${2:-}
  local already=${ADAPTER_ALREADY_INSTALLED:-false}
  echo "=== NANOCLAW SETUP: ADD_SIGNAL ==="
  echo "STATUS: ${status}"
  echo "ADAPTER_ALREADY_INSTALLED: ${already}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-signal] $*" >&2; }

need_install() {
  [ ! -f src/channels/signal.ts ] && return 0
  ! grep -q "^import './signal.js';" src/channels/index.ts 2>/dev/null && return 0
  return 1
}

ADAPTER_ALREADY_INSTALLED=true
if need_install; then
  ADAPTER_ALREADY_INSTALLED=false
  log "Fetching channels branch…"
  git fetch "$CHANNELS_REMOTE" channels >&2 2>/dev/null || {
    emit_status failed "git fetch ${CHANNELS_REMOTE} channels failed"
    exit 1
  }

  log "Copying adapter files from ${CHANNELS_BRANCH}…"
  for f in \
    src/channels/signal.ts \
    src/channels/signal.test.ts
  do
    git show "${CHANNELS_BRANCH}:$f" > "$f" || {
      emit_status failed "git show ${CHANNELS_BRANCH}:$f failed"
      exit 1
    }
  done

  if ! grep -q "^import './signal.js';" src/channels/index.ts; then
    echo "import './signal.js';" >> src/channels/index.ts
  fi
fi

# qrcode is needed by setup/signal-auth.ts to render the linking URL as a
# terminal QR. Install idempotently — if it's already present (e.g. from a
# prior WhatsApp install) pnpm is a no-op.
if ! node -e "require.resolve('qrcode')" >/dev/null 2>&1; then
  log "Installing ${QRCODE_VERSION}…"
  pnpm install "${QRCODE_VERSION}" "${QRCODE_TYPES_VERSION}" >&2 2>/dev/null || {
    emit_status failed "pnpm install ${QRCODE_VERSION} failed"
    exit 1
  }
fi

log "Building…"
pnpm run build >&2 2>/dev/null || {
  emit_status failed "pnpm run build failed"
  exit 1
}

emit_status success
