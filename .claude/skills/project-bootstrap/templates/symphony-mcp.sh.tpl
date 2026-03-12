#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="$REPO_ROOT/.nanoclaw/project-bootstrap.json"

ORCHESTRATOR_ROOT="${NANOCLAW_ORCHESTRATOR_ROOT:-}"
if [[ -z "$ORCHESTRATOR_ROOT" && -f "$MANIFEST" ]]; then
  ORCHESTRATOR_ROOT="$(node --input-type=module <<'EOF'
import fs from 'node:fs';

const manifestPath = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
process.stdout.write(manifest.orchestratorRoot || '');
EOF
"$MANIFEST")"
fi

if [[ -z "$ORCHESTRATOR_ROOT" ]]; then
  echo "Missing NanoClaw orchestrator root. Set NANOCLAW_ORCHESTRATOR_ROOT or re-run project bootstrap." >&2
  exit 1
fi

exec bash "$ORCHESTRATOR_ROOT/scripts/workflow/run-with-env.sh" \
  npx tsx "$ORCHESTRATOR_ROOT/scripts/workflow/symphony-mcp.ts"
