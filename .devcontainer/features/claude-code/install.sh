#!/usr/bin/env bash
set -euo pipefail

VERSION="${VERSION:-latest}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required before installing Claude Code" >&2
  exit 1
fi

npm install -g "@anthropic-ai/claude-code@${VERSION}"
