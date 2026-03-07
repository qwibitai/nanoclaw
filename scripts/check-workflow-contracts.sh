#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

missing_refs=()
errors=()

collect_files=()
collect_files+=("docs/ARCHITECTURE.md" "CLAUDE.md" "AGENTS.md" "DOCS.md" "docs/README.md")
collect_files+=(
  "docs/workflow/docs-discipline/skill-routing-preflight.md"
  "docs/workflow/runtime/jarvis-dispatch-contract-discipline.md"
  "docs/workflow/runtime/nanoclaw-jarvis-debug-loop.md"
  "docs/workflow/docs-discipline/nanoclaw-root-claude-compression.md"
  "docs/workflow/docs-discipline/docs-pruning-loop.md"
)

while IFS= read -r f; do collect_files+=("$f"); done < <(find docs/workflow docs/operations -type f -name '*.md' | sort)

refs_tmp="$(mktemp /tmp/workflow-doc-refs.XXXXXX)"
trap 'rm -f "$refs_tmp"' EXIT

has_rg=0
if command -v rg >/dev/null 2>&1; then
  has_rg=1
fi

extract_doc_refs() {
  local file="$1"
  if [ "$has_rg" -eq 1 ]; then
    rg -o --no-filename 'docs/[A-Za-z0-9._/-]+\.md' "$file" || true
    return
  fi
  grep -Eo 'docs/[A-Za-z0-9._/-]+\.md' "$file" || true
}

has_text() {
  local pattern="$1"
  local file="$2"
  if [ "$has_rg" -eq 1 ]; then
    rg -q "$pattern" "$file"
    return
  fi
  grep -Eq "$pattern" "$file"
}

for f in "${collect_files[@]}"; do
  [ -f "$f" ] || continue
  extract_doc_refs "$f" >>"$refs_tmp"
done

sort -u "$refs_tmp" -o "$refs_tmp"

while IFS= read -r ref; do
  [ -n "$ref" ] || continue

  case "$ref" in
    *YYYY-MM-DD*|*CHANGELOG-YYYY-*)
      continue
      ;;
    docs/github-workflow-admin.md|docs/github.md|docs/jarvis-dispatch.md|docs/review-handoff.md|docs/workflow/execution-loop.md|docs/workflow/worker-skill-policy.md|docs/workflow/git-pr-workflow.md|docs/workflow/github-account-isolation.md)
      # Runtime-lane docs referenced from groups/* paths; not root docs.
      continue
      ;;
  esac

  if [ ! -f "$ref" ]; then
    missing_refs+=("$ref")
  fi
done <"$refs_tmp"

if [ ! -f "docs/workflow/delivery/nanoclaw-development-loop.md" ]; then
  errors+=("Missing canonical workflow doc: docs/workflow/delivery/nanoclaw-development-loop.md")
fi

if [ ! -f "docs/ARCHITECTURE.md" ]; then
  errors+=("Missing architecture boundary contract: docs/ARCHITECTURE.md")
fi

if [ ! -f "docs/workflow/strategy/workflow-optimization-loop.md" ]; then
  errors+=("Missing optimization workflow doc: docs/workflow/strategy/workflow-optimization-loop.md")
fi

if [ ! -f "docs/workflow/strategy/weekly-slop-optimization-loop.md" ]; then
  errors+=("Missing weekly slop optimization workflow doc: docs/workflow/strategy/weekly-slop-optimization-loop.md")
fi

if [ ! -f "docs/workflow/delivery/unified-codex-claude-loop.md" ]; then
  errors+=("Missing unified cross-tool workflow doc: docs/workflow/delivery/unified-codex-claude-loop.md")
fi

if [ ! -f "docs/operations/claude-codex-adapter-matrix.md" ]; then
  errors+=("Missing adapter matrix doc: docs/operations/claude-codex-adapter-matrix.md")
fi

if [ ! -f "docs/operations/subagent-catalog.md" ]; then
  errors+=("Missing subagent catalog doc: docs/operations/subagent-catalog.md")
fi

if [ ! -f "docs/operations/tooling-governance-budget.json" ]; then
  errors+=("Missing tooling governance budget: docs/operations/tooling-governance-budget.json")
fi

if [ ! -x "scripts/check-tooling-governance.sh" ]; then
  errors+=("Missing executable tooling governance checker: scripts/check-tooling-governance.sh")
fi

if [ ! -x "scripts/workflow/slop-inventory.sh" ]; then
  errors+=("Missing executable slop inventory helper: scripts/workflow/slop-inventory.sh")
fi

if [ ! -x "scripts/check-architecture-boundary.sh" ]; then
  errors+=("Missing executable architecture boundary checker: scripts/check-architecture-boundary.sh")
fi

if ! has_text 'docs/workflow/delivery/nanoclaw-development-loop.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing development-loop trigger reference")
fi

if ! has_text 'docs/workflow/strategy/workflow-optimization-loop.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing workflow-optimization-loop trigger reference")
fi

if ! has_text 'docs/workflow/strategy/weekly-slop-optimization-loop.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing weekly-slop-optimization-loop trigger reference")
fi

if ! has_text 'docs/operations/tooling-governance-budget.json' CLAUDE.md; then
  errors+=("CLAUDE.md is missing tooling-governance-budget trigger reference")
fi

if ! has_text 'docs/workflow/delivery/unified-codex-claude-loop.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing unified-codex-claude-loop trigger reference")
fi

if ! has_text 'docs/operations/claude-codex-adapter-matrix.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing claude-codex-adapter-matrix trigger reference")
fi

if ! has_text 'docs/operations/subagent-catalog.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing subagent-catalog trigger reference")
fi

if ! has_text 'docs/ARCHITECTURE.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing architecture boundary trigger reference")
fi

if ! has_text 'docs/ARCHITECTURE.md' AGENTS.md; then
  errors+=("AGENTS.md is missing architecture boundary reference")
fi

if has_text 'docs/nanoclaw-jarvis-dispatch-contract.md' docs/workflow/runtime/jarvis-dispatch-contract-discipline.md; then
  errors+=("jarvis-dispatch-contract-discipline.md still references deprecated path docs/nanoclaw-jarvis-dispatch-contract.md")
fi

if [ -x "scripts/check-architecture-boundary.sh" ]; then
  boundary_output="$(bash scripts/check-architecture-boundary.sh 2>&1)" || {
    errors+=("architecture-boundary-check failed:")
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      errors+=("  $line")
    done <<<"$boundary_output"
  }
fi

if [ "${#missing_refs[@]}" -gt 0 ]; then
  errors+=("Broken doc references detected:")
  for ref in "${missing_refs[@]}"; do
    errors+=("  - ${ref}")
  done
fi

if [ "${#errors[@]}" -gt 0 ]; then
  echo "workflow-contract-check: FAIL"
  for e in "${errors[@]}"; do
    echo "$e"
  done
  exit 1
fi

echo "workflow-contract-check: PASS"
exit 0
