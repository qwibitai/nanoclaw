#!/usr/bin/env bash
set -euo pipefail

staged_files="$(git diff --cached --name-only --diff-filter=ACMR)"
staged_diff="$(git diff --cached --text --unified=0 --no-color)"
filtered_staged_files="$(printf '%s\n' "$staged_files" | rg -v '(^|/)\.env\.example$' || true)"

forbidden_files_regex='(^|/)\.env($|\.)|(^|/)\.mcp\.local\.json$|(^|/)\.claude/settings\.local\.json$|(^|/)messages\.db$|(^|/).*credentials.*\.json$|(^|/).*(token|secret|oauth).*\.(json|txt|env)$'
secret_patterns=(
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk-ant-oat[A-Za-z0-9_-]{20,}'
  'sk-[A-Za-z0-9_-]{20,}'
  'ghp_[A-Za-z0-9_]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'AIza[A-Za-z0-9_-]{20,}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  'Bearer[[:space:]]+eyJ[A-Za-z0-9._-]{20,}'
)

if [[ -n "$filtered_staged_files" ]] && printf '%s\n' "$filtered_staged_files" | rg -n "$forbidden_files_regex" >/dev/null; then
  echo "Blocked: forbidden local/secret file is staged."
  printf '%s\n' "$filtered_staged_files" | rg -n "$forbidden_files_regex" || true
  exit 1
fi

for pattern in "${secret_patterns[@]}"; do
  if [[ -n "$staged_diff" ]] && printf '%s\n' "$staged_diff" | rg -n "$pattern" >/dev/null; then
    echo "Blocked: staged diff looks like it contains a secret."
    printf '%s\n' "$staged_diff" | rg -n "$pattern" || true
    exit 1
  fi
done

echo "Secret scan passed."
