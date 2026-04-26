#!/usr/bin/env bash
# Setup helper: install-webex — bundles the preflight + install commands
# from the /add-webex skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the Webex adapter in from the `channels` branch; appends the
# self-registration import; installs the pinned @bitbasti/chat-adapter-webex
# package; builds. All steps are safe to re-run.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve the trusted remote that carries the channels branch.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_WEBEX ==="

needs_install=false
[[ -f src/channels/webex.ts ]] || needs_install=true
grep -q "import './webex.js';" src/channels/index.ts || needs_install=true
grep -q '"@bitbasti/chat-adapter-webex"' package.json || needs_install=true
[[ -d node_modules/@bitbasti/chat-adapter-webex ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch "$CHANNELS_REMOTE" channels

echo "STEP: copy-files"
git show "${CHANNELS_REMOTE}/channels":src/channels/webex.ts > src/channels/webex.ts

echo "STEP: register-import"
if ! grep -q "import './webex.js';" src/channels/index.ts; then
  printf "import './webex.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @bitbasti/chat-adapter-webex@0.1.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
