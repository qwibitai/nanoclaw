#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

errors=()

has_rg=0
if command -v rg >/dev/null 2>&1; then
  has_rg=1
fi

require_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    errors+=("Missing required file: $path")
  fi
}

require_exec() {
  local path="$1"
  if [ ! -x "$path" ]; then
    errors+=("Hook/script must be executable: $path")
  fi
}

require_pattern() {
  local file="$1"
  local pattern="$2"
  local message="$3"
  if [ "$has_rg" -eq 1 ]; then
    if ! rg -q "$pattern" "$file"; then
      errors+=("$message")
    fi
    return
  fi
  if ! grep -Eq "$pattern" "$file"; then
    errors+=("$message")
  fi
}

require_file "CLAUDE.md"
require_file "AGENTS.md"
require_file "docs/workflow/delivery/unified-codex-claude-loop.md"
require_file "docs/operations/claude-codex-adapter-matrix.md"
require_file "docs/operations/subagent-catalog.md"
require_file "docs/operations/tooling-governance-budget.json"
require_file ".codex/config.toml"
require_file ".codex/agents/explorer.toml"
require_file ".codex/agents/reviewer.toml"
require_file ".codex/agents/monitor.toml"
require_file ".codex/agents/worker.toml"
require_file ".claude/settings.local.json"
require_file ".claude/hooks/risk-tier-pretool-guard.sh"
require_file ".claude/hooks/posttool-workflow-sync-check.sh"
require_file "scripts/check-tooling-governance.sh"

if [ -L ".codex/settings.local.json" ]; then
  target="$(readlink .codex/settings.local.json)"
  if [ "$target" != "../.claude/settings.local.json" ]; then
    errors+=(".codex/settings.local.json symlink target drifted: $target")
  fi
else
  errors+=(".codex/settings.local.json should be a symlink to ../.claude/settings.local.json")
fi

require_pattern "CLAUDE.md" 'docs/workflow/delivery/unified-codex-claude-loop.md' "CLAUDE.md missing unified workflow trigger"
require_pattern "CLAUDE.md" 'docs/operations/claude-codex-adapter-matrix.md' "CLAUDE.md missing adapter matrix trigger"
require_pattern "CLAUDE.md" 'docs/operations/subagent-catalog.md' "CLAUDE.md missing subagent catalog trigger"
require_pattern "CLAUDE.md" 'docs/operations/tooling-governance-budget.json' "CLAUDE.md missing tooling governance budget trigger"

require_pattern "AGENTS.md" 'docs/workflow/delivery/unified-codex-claude-loop.md' "AGENTS.md missing unified workflow mirror reference"
require_pattern "AGENTS.md" 'docs/operations/claude-codex-adapter-matrix.md' "AGENTS.md missing adapter matrix mirror reference"
require_pattern "AGENTS.md" 'docs/operations/subagent-catalog.md' "AGENTS.md missing subagent catalog mirror reference"
require_pattern "AGENTS.md" 'docs/operations/tooling-governance-budget.json' "AGENTS.md missing tooling governance budget mirror reference"

require_pattern ".codex/config.toml" '\[agents\.explorer\]' ".codex/config.toml missing explorer role"
require_pattern ".codex/config.toml" '\[agents\.reviewer\]' ".codex/config.toml missing reviewer role"
require_pattern ".codex/config.toml" '\[agents\.monitor\]' ".codex/config.toml missing monitor role"
require_pattern ".codex/config.toml" '\[agents\.worker\]' ".codex/config.toml missing worker role"

require_pattern ".claude/settings.local.json" '"hooks"' ".claude/settings.local.json missing hooks config"
require_pattern ".claude/settings.local.json" 'risk-tier-pretool-guard\.sh' ".claude/settings.local.json missing risk-tier pretool hook"
require_pattern ".claude/settings.local.json" 'posttool-workflow-sync-check\.sh' ".claude/settings.local.json missing posttool workflow sync hook"

require_exec ".claude/hooks/risk-tier-pretool-guard.sh"
require_exec ".claude/hooks/posttool-workflow-sync-check.sh"
require_exec "scripts/check-tooling-governance.sh"

if [ "${#errors[@]}" -gt 0 ]; then
  echo "claude-codex-mirror-check: FAIL"
  for e in "${errors[@]}"; do
    echo "$e"
  done
  exit 1
fi

echo "claude-codex-mirror-check: PASS"
exit 0
