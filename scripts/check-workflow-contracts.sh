#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

missing_refs=()
errors=()

collect_files=()
collect_files+=("CLAUDE.md" "AGENTS.md" "DOCS.md" "docs/README.md")
collect_files+=(
  ".claude/rules/skill-routing-preflight.md"
  ".claude/rules/jarvis-dispatch-contract-discipline.md"
  ".claude/rules/nanoclaw-jarvis-debug-loop.md"
  ".claude/rules/nanoclaw-root-claude-compression.md"
  ".claude/rules/docs-pruning-loop.md"
)

while IFS= read -r f; do collect_files+=("$f"); done < <(find docs/workflow docs/operations -type f -name '*.md' | sort)

refs_tmp="$(mktemp /tmp/workflow-doc-refs.XXXXXX)"
trap 'rm -f "$refs_tmp"' EXIT

for f in "${collect_files[@]}"; do
  [ -f "$f" ] || continue
  rg -o --no-filename 'docs/[A-Za-z0-9._/-]+\.md' "$f" >>"$refs_tmp" || true
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

if [ ! -f "docs/workflow/nanoclaw-development-loop.md" ]; then
  errors+=("Missing canonical workflow doc: docs/workflow/nanoclaw-development-loop.md")
fi

if [ ! -f "docs/workflow/workflow-optimization-loop.md" ]; then
  errors+=("Missing optimization workflow doc: docs/workflow/workflow-optimization-loop.md")
fi

if [ ! -f "docs/workflow/weekly-slop-optimization-loop.md" ]; then
  errors+=("Missing weekly slop optimization workflow doc: docs/workflow/weekly-slop-optimization-loop.md")
fi

if [ ! -f "docs/workflow/unified-codex-claude-loop.md" ]; then
  errors+=("Missing unified cross-tool workflow doc: docs/workflow/unified-codex-claude-loop.md")
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

if ! rg -q 'docs/workflow/nanoclaw-development-loop.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing development-loop trigger reference")
fi

if ! rg -q 'docs/workflow/workflow-optimization-loop.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing workflow-optimization-loop trigger reference")
fi

if ! rg -q 'docs/workflow/weekly-slop-optimization-loop.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing weekly-slop-optimization-loop trigger reference")
fi

if ! rg -q 'docs/operations/tooling-governance-budget.json' CLAUDE.md; then
  errors+=("CLAUDE.md is missing tooling-governance-budget trigger reference")
fi

if ! rg -q 'docs/workflow/unified-codex-claude-loop.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing unified-codex-claude-loop trigger reference")
fi

if ! rg -q 'docs/operations/claude-codex-adapter-matrix.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing claude-codex-adapter-matrix trigger reference")
fi

if ! rg -q 'docs/operations/subagent-catalog.md' CLAUDE.md; then
  errors+=("CLAUDE.md is missing subagent-catalog trigger reference")
fi

if rg -q 'docs/nanoclaw-jarvis-dispatch-contract.md' .claude/rules/jarvis-dispatch-contract-discipline.md; then
  errors+=("jarvis-dispatch-contract-discipline.md still references deprecated path docs/nanoclaw-jarvis-dispatch-contract.md")
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
