#!/usr/bin/env bash
set -euo pipefail

payload_file="$(mktemp /tmp/risk-tier-pretool.XXXXXX.json)"
trap 'rm -f "$payload_file"' EXIT
cat >"$payload_file" || true

if [ ! -s "$payload_file" ]; then
  exit 0
fi

# Block destructive shell patterns regardless of tool assignment.
if rg -q 'git reset --hard|git checkout --|rm -rf /$|rm -rf / |rm -rf \./|rm -rf \..|: >' "$payload_file"; then
  echo "blocked by risk-tier guard: destructive shell pattern detected" >&2
  exit 2
fi

# Protect shared workflow contract surfaces from direct deletion operations.
if rg -q 'CLAUDE\.md|AGENTS\.md|docs/workflow|docs/operations|\.codex/config\.toml|\.claude/settings\.local\.json' "$payload_file"; then
  if rg -q '"tool_name"\s*:\s*"Bash"' "$payload_file" && rg -q 'rm\s+-rf|rm\s+-f' "$payload_file"; then
    echo "blocked by risk-tier guard: contract/governance surfaces cannot be removed via Bash" >&2
    exit 2
  fi
fi

exit 0
