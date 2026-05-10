#!/usr/bin/env bash
# Setup helper: install-discord — bundles the preflight + install commands
# from the /add-discord skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the Discord adapter in from the `channels` branch; appends the
# self-registration import; installs the pinned @chat-adapter/discord package;
# builds. All steps are safe to re-run.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Resolve and validate the trusted remote that carries the executable channel adapter code.
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

echo "=== NANOCLAW SETUP: INSTALL_DISCORD ==="

needs_install=false
[[ -f src/channels/discord.ts ]] || needs_install=true
grep -q "import './discord.js';" src/channels/index.ts || needs_install=true
grep -q '"@chat-adapter/discord"' package.json || needs_install=true
[[ -d node_modules/@chat-adapter/discord ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch "$CHANNELS_REMOTE" channels

echo "STEP: copy-files"
git show "${CHANNELS_BRANCH}:src/channels/discord.ts" > src/channels/discord.ts

echo "STEP: register-import"
if ! grep -q "import './discord.js';" src/channels/index.ts; then
  printf "import './discord.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @chat-adapter/discord@4.26.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
