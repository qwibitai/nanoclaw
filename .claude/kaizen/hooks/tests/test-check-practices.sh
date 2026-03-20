#!/bin/bash
# Tests for check-practices.sh hook
# Run: bash .claude/kaizen/hooks/tests/test-check-practices.sh
#
# INVARIANT: gh pr create shows advisory practices checklist on stderr.
# INVARIANT: Non-PR commands are ignored (no output).
# INVARIANT: Hook never blocks (always exit 0, no deny JSON on stdout).
# INVARIANT: Practices shown are filtered by change category (shell, TS, hooks, container, docs).
# INVARIANT: Always-relevant practices (DRY, URLs, Evidence) appear for all PRs.
# SUT: check-practices.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
HOOK="$HOOKS_DIR/check-practices.sh"
source "$SCRIPT_DIR/test-helpers.sh"

setup_mock_dir
trap 'rm -rf "$MOCK_DIR"' EXIT

# Local helper: setup git mock with printf '%b' so \n becomes real newlines
setup_git_diff_mock() {
  local git_files="$1"
  cat > "$MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
exit 1
MOCK
  chmod +x "$MOCK_DIR/gh"

  cat > "$MOCK_DIR/git" << MOCK
#!/bin/bash
if echo "\$@" | grep -q "remote get-url"; then
  echo "https://github.com/Garsson-io/nanoclaw.git"
  exit 0
fi
if echo "\$@" | grep -q "diff --name-only"; then
  printf '%b\n' "$git_files"
  exit 0
fi
if echo "\$@" | grep -q "status --porcelain"; then
  exit 0
fi
/usr/bin/git "\$@"
MOCK
  chmod +x "$MOCK_DIR/git"
}

echo "=== Non-PR commands are ignored ==="

OUTPUT=$(echo '{"tool_input":{"command":"npm run build"}}' | bash "$HOOK" 2>&1)
assert_eq "npm command exits silently" "" "$OUTPUT"

OUTPUT=$(echo '{"tool_input":{"command":"git push origin main"}}' | bash "$HOOK" 2>&1)
assert_eq "git push exits silently" "" "$OUTPUT"

OUTPUT=$(echo '{"tool_input":{"command":"gh pr merge 42"}}' | bash "$HOOK" 2>&1)
assert_eq "gh pr merge exits silently" "" "$OUTPUT"

echo ""
echo "=== gh pr create with TS changes shows practices ==="

setup_git_diff_mock "src/cases.ts\nsrc/ipc.ts"

STDERR=$(run_hook_stderr "$HOOK" "gh pr create --title 'test' --body 'stuff'")
assert_contains "shows PRACTICES CHECKLIST header" "PRACTICES CHECKLIST" "$STDERR"
assert_contains "shows DRY (always relevant)" "DRY" "$STDERR"
assert_contains "shows Display URLs (always relevant)" "Display URLs" "$STDERR"
assert_contains "shows Evidence (always relevant)" "Evidence" "$STDERR"
assert_contains "shows Minimal surface (TS-specific)" "Minimal surface" "$STDERR"
assert_contains "shows Dependencies (TS-specific)" "Dependencies" "$STDERR"
assert_contains "shows Harness or vertical (TS-specific)" "Harness or vertical" "$STDERR"

# Should NOT show container-specific practices
assert_not_contains "no deployed artifact for TS-only" "deployed artifact" "$STDERR"

echo ""
echo "=== Shell changes show error path practices ==="

setup_git_diff_mock "scripts/lib/resolve-cli-kaizen.sh"

STDERR=$(run_hook_stderr "$HOOK" "gh pr create --title 'test' --body 'stuff'")
assert_contains "shows Error paths for shell" "Error paths" "$STDERR"
assert_contains "shows interaction test for shell" "interaction" "$STDERR"

echo ""
echo "=== Hook changes show isolation practices ==="

setup_git_diff_mock ".claude/kaizen/hooks/enforce-pr-review.sh"

STDERR=$(run_hook_stderr "$HOOK" "gh pr create --title 'test' --body 'stuff'")
assert_contains "shows Worktree isolation for hooks" "isolation" "$STDERR"
assert_contains "shows Error paths for hooks" "Error paths" "$STDERR"

echo ""
echo "=== Container changes show artifact practices ==="

setup_git_diff_mock "container/Dockerfile\ncontainer/agent-runner/src/tool.ts"

STDERR=$(run_hook_stderr "$HOOK" "gh pr create --title 'test' --body 'stuff'")
assert_contains "shows deployed artifact for container" "deployed artifact" "$STDERR"
assert_contains "shows fresh state for container" "fresh state" "$STDERR"

echo ""
echo "=== Docs-only changes still show universal practices ==="

setup_git_diff_mock "docs/architecture.md\nREADME.md"

STDERR=$(run_hook_stderr "$HOOK" "gh pr create --title 'test' --body 'stuff'")
assert_contains "shows DRY for docs" "DRY" "$STDERR"
assert_contains "shows URLs for docs" "Display URLs" "$STDERR"
# Should NOT show TS-specific practices
assert_not_contains "no Minimal surface for docs-only" "Minimal surface" "$STDERR"
assert_not_contains "no Dependencies for docs-only" "Dependencies" "$STDERR"

echo ""
echo "=== Never blocks (always exit 0, no deny on stdout) ==="

setup_git_diff_mock "src/index.ts"

OUTPUT=$(run_hook "$HOOK" "gh pr create --title 'test' --body 'stuff'")
assert_eq "no deny JSON on stdout" "" "$OUTPUT"

echo ""
echo "=== Mixed changes show combined practices ==="

setup_git_diff_mock "src/cases.ts\n.claude/kaizen/hooks/check-wip.sh\ncontainer/Dockerfile"

STDERR=$(run_hook_stderr "$HOOK" "gh pr create --title 'test' --body 'stuff'")
assert_contains "shows TS practices" "Minimal surface" "$STDERR"
assert_contains "shows hook practices" "isolation" "$STDERR"
assert_contains "shows container practices" "deployed artifact" "$STDERR"
assert_contains "shows shell practices" "Error paths" "$STDERR"

echo ""
echo "=== No changed files → no output ==="

setup_git_diff_mock ""

OUTPUT=$(echo '{"tool_input":{"command":"gh pr create --title test --body stuff"}}' | PATH="$MOCK_DIR:$PATH" bash "$HOOK" 2>&1)
assert_eq "no files → no output" "" "$OUTPUT"

print_results
