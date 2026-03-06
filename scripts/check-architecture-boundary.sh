#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

errors=()

has_rg=0
if command -v rg >/dev/null 2>&1; then
  has_rg=1
fi

has_text() {
  local pattern="$1"
  local file="$2"
  if [ "$has_rg" -eq 1 ]; then
    rg -q "$pattern" "$file"
    return
  fi
  grep -Eq "$pattern" "$file"
}

collect_matches() {
  local pattern="$1"
  local file="$2"
  if [ "$has_rg" -eq 1 ]; then
    rg -n "$pattern" "$file" || true
    return
  fi
  grep -En "$pattern" "$file" || true
}

require_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    errors+=("missing required boundary file: $path")
  fi
}

require_ref() {
  local path="$1"
  local file="$2"
  if [ ! -f "$file" ] || ! has_text "$path" "$file"; then
    errors+=("$file is missing required architecture-boundary reference: $path")
  fi
}

require_file "docs/ARCHITECTURE.md"
require_ref "docs/ARCHITECTURE.md" "CLAUDE.md"
require_ref "docs/ARCHITECTURE.md" "AGENTS.md"
require_ref "docs/ARCHITECTURE.md" "DOCS.md"
require_ref "docs/ARCHITECTURE.md" "docs/README.md"

required_contract_sections=(
  "^## Requirements$"
  "^### Frozen Core$"
  "^### Shared Integration Seams$"
  "^### Jarvis Extension$"
  "^## Validation Gates$"
  "^## Exit Criteria$"
)

for section in "${required_contract_sections[@]}"; do
  if [ ! -f "docs/ARCHITECTURE.md" ] || ! has_text "$section" "docs/ARCHITECTURE.md"; then
    errors+=("docs/ARCHITECTURE.md is missing required contract section matching: $section")
  fi
done

jarvis_markers='andy-developer|jarvis-worker|@nanoclaw|dispatch_attempts|source_lane_id'

frozen_core_files=(
  "src/group-queue.ts"
  "src/router.ts"
  "src/group-folder.ts"
)

while IFS= read -r path; do
  frozen_core_files+=("$path")
done < <(find src/channels -type f -name '*.ts' | sort)

for file in "${frozen_core_files[@]}"; do
  [ -f "$file" ] || continue
  matches="$(collect_matches "$jarvis_markers" "$file")"
  if [ -n "$matches" ]; then
    errors+=("Jarvis-specific markers leaked into frozen core file: $file")
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      errors+=("  $line")
    done <<<"$matches"
  fi
done

allowed_extension_importers=(
  "src/index.ts"
  "src/ipc.ts"
)

is_allowed_importer() {
  local candidate="$1"
  for allowed in "${allowed_extension_importers[@]}"; do
    if [ "$candidate" = "$allowed" ]; then
      return 0
    fi
  done
  return 1
}

while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  file="${hit%%:*}"
  if [[ "$file" == src/extensions/jarvis/* ]]; then
    continue
  fi
  if is_allowed_importer "$file"; then
    continue
  fi
  errors+=("Only shared integration seams may import src/extensions/jarvis/*: $hit")
done < <(
  if [ "$has_rg" -eq 1 ]; then
    rg -n "extensions/jarvis" src --glob '*.ts' || true
  else
    find src -type f -name '*.ts' -print0 | xargs -0 grep -En "extensions/jarvis" || true
  fi
)

if [ "${#errors[@]}" -gt 0 ]; then
  echo "architecture-boundary-check: FAIL"
  for error in "${errors[@]}"; do
    echo "$error"
  done
  exit 1
fi

echo "architecture-boundary-check: PASS"
