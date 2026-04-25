#!/usr/bin/env bash
# Setup helper: install-resend — bundles the preflight + install commands
# from the /add-resend skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the Resend adapter in from the `channels` branch; appends the
# self-registration import; installs the pinned @resend/chat-sdk-adapter
# package; builds. All steps are safe to re-run.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Resolve and validate the trusted remote that carries the executable channel adapter code.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

echo "=== NANOCLAW SETUP: INSTALL_RESEND ==="

needs_install=false
[[ -f src/channels/resend.ts ]] || needs_install=true
grep -q "import './resend.js';" src/channels/index.ts || needs_install=true
grep -q '"@resend/chat-sdk-adapter"' package.json || needs_install=true
[[ -d node_modules/@resend/chat-sdk-adapter ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch "$CHANNELS_REMOTE" channels

echo "STEP: copy-files"
git show "${CHANNELS_BRANCH}:src/channels/resend.ts" > src/channels/resend.ts

echo "STEP: register-import"
if ! grep -q "import './resend.js';" src/channels/index.ts; then
  printf "import './resend.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @resend/chat-sdk-adapter@0.1.1

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
