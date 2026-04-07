#!/usr/bin/env bash
set -euo pipefail

staged_files=()
while IFS= read -r file; do
  staged_files+=("$file")
done < <(
  git diff --cached --name-only --diff-filter=ACMR \
    | rg '\.(ts|tsx|js|jsx)$' \
    | rg '^(src|setup|runners)/'
)

if [[ ${#staged_files[@]} -eq 0 ]]; then
  echo "No staged TS/JS files to lint."
  exit 0
fi

npx eslint --quiet "${staged_files[@]}"
