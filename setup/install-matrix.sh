#!/usr/bin/env bash
# Setup helper: install-matrix — bundles the preflight + install commands
# from the /add-matrix skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the Matrix adapter in from the `channels` branch; appends the
# self-registration import; installs the pinned @beeper/chat-adapter-matrix
# package; patches the adapter's published dist so its matrix-js-sdk/lib
# imports carry .js extensions (required under Node 22 strict ESM); builds.
# All steps are safe to re-run — re-run this script after any pnpm install
# that touches the adapter.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_MATRIX ==="

needs_install=false
[[ -f src/channels/matrix.ts ]] || needs_install=true
grep -q "import './matrix.js';" src/channels/index.ts || needs_install=true
grep -q '"@beeper/chat-adapter-matrix"' package.json || needs_install=true
[[ -d node_modules/@beeper/chat-adapter-matrix ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-files"
git show origin/channels:src/channels/matrix.ts > src/channels/matrix.ts

echo "STEP: register-import"
if ! grep -q "import './matrix.js';" src/channels/index.ts; then
  printf "import './matrix.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @beeper/chat-adapter-matrix@0.2.0

echo "STEP: patch-esm-extensions"
node -e '
  const fs = require("fs"), path = require("path");
  const root = "node_modules/.pnpm";
  const dir = fs.readdirSync(root).find(d => d.startsWith("@beeper+chat-adapter-matrix@"));
  if (!dir) { console.log("Matrix adapter not installed"); process.exit(0); }
  const f = path.join(root, dir, "node_modules/@beeper/chat-adapter-matrix/dist/index.js");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(
    /from "(matrix-js-sdk\/lib\/[^"]+?)(?<!\.js)"/g, "from \"$1.js\""
  ));
  console.log("Patched", f);
'

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
