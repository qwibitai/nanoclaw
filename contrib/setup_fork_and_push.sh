#!/usr/bin/env bash
# Usage: ./contrib/setup_fork_and_push.sh YOUR_GITHUB_USERNAME
# Prereq: fork https://github.com/qwibitai/nanoclaw to https://github.com/YOUR_GITHUB_USERNAME/nanoclaw on GitHub first.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

USER="${1:-}"
if [[ -z "$USER" ]]; then
  echo "Usage: $0 <your_github_username>"
  echo "Example: $0 octocat"
  exit 1
fi

FORK_URL="https://github.com/${USER}/nanoclaw.git"

if git remote get-url origin >/dev/null 2>&1; then
  echo "Remote 'origin' already exists:"
  git remote get-url origin
  read -r -p "Replace with ${FORK_URL}? [y/N] " a
  if [[ "${a:-}" == "y" || "${a:-}" == "Y" ]]; then
    git remote set-url origin "$FORK_URL"
  else
    echo "Abort. Set origin yourself, then: git push -u origin skill/auto-evo"
    exit 1
  fi
else
  git remote add origin "$FORK_URL"
fi

echo "Pushing branch skill/auto-evo to origin..."
git push -u origin skill/auto-evo

if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    gh pr create --repo qwibitai/nanoclaw \
      --base main \
      --head "${USER}:skill/auto-evo" \
      --title "feat(skill): add auto-evo (session-injected group strategy memory)" \
      --body-file pr-body.md
  else
    echo "Run: gh auth login"
    echo "Then: gh pr create --repo qwibitai/nanoclaw --base main --head ${USER}:skill/auto-evo --title \"...\" --body-file pr-body.md"
  fi
else
  echo "'gh' not installed. Open: https://github.com/qwibitai/nanoclaw/compare/main...${USER}:nanoclaw:skill/auto-evo"
fi
