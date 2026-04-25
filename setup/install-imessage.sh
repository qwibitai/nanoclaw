#!/usr/bin/env bash
# Setup helper: install-imessage — bundles the preflight + install commands
# from the /add-imessage skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the iMessage adapter in from the `channels` branch; appends the
# self-registration import; installs the pinned chat-adapter-imessage package;
# builds. Local vs remote mode pick stays in the skill — this script only
# handles the deterministic install. All steps are safe to re-run.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_IMESSAGE ==="

needs_install=false
[[ -f src/channels/imessage.ts ]] || needs_install=true
grep -q "import './imessage.js';" src/channels/index.ts || needs_install=true
grep -q '"chat-adapter-imessage"' package.json || needs_install=true
[[ -d node_modules/chat-adapter-imessage ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-files"
git show origin/channels:src/channels/imessage.ts > src/channels/imessage.ts

echo "STEP: register-import"
if ! grep -q "import './imessage.js';" src/channels/index.ts; then
  printf "import './imessage.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install chat-adapter-imessage@0.1.1

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
