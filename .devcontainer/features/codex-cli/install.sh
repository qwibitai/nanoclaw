#!/usr/bin/env bash
set -euo pipefail

VERSION="${VERSION:-latest}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required before installing Codex CLI" >&2
  exit 1
fi

npm install -g "@openai/codex@${VERSION}"

