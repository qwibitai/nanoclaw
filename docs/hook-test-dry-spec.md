# Hook Test Infrastructure DRY Refactoring — Specification

## 1. Problem Statement

The hook test suite (`.claude/kaizen/hooks/tests/`) has ~308 lines of duplicated boilerplate across 10+ files. The same mock `gh`, `create_state()`, `setup()`/`teardown()`, and decision-extraction helpers are copy-pasted with minor variations. When a shared function like `find_needs_review_state()` gains a new external dependency (as happened with kaizen #85's `gh pr view` call), every test file must be updated independently — 10 files touched, ~300 lines added, for what should have been a 1-line change.

### Cost

- **Kaizen #85 implementation:** 3 source files changed (35 lines), 10 test files changed (300+ lines). Test boilerplate was 10x the actual fix.
- **Ongoing maintenance:** Each new hook or shared-function change requires updating N test files instead of 1.
- **Bug surface:** Pre-existing bugs in duplicated code (e.g., `create_state()` missing BRANCH field in `harness.py`) went undetected because fixes to one copy didn't propagate.

## 2. Desired End State

Each test file contains only:
1. A `source` line to import shared infrastructure
2. Hook-specific test cases

All environment setup, mock creation, state management helpers, and decision extractors live in shared files, sourced once.

**What's explicitly NOT in scope:**
- Consolidating bash and Python test suites (they test different things)
- Changing hook architecture or behavior
- Adding new tests — this is purely DRY refactoring of existing infrastructure

## 3. What Exists vs What Needs Building

### Already Solved

| Capability | Current implementation | Status |
|---|---|---|
| Assertions | `test-helpers.sh`: assert_eq, assert_contains, assert_not_contains, assert_ok, assert_fails | Good — sourced by all bash tests |
| Integration harness | `harness.sh`: run_single_hook, build_*_input, validate_deny_output | Good — used by integration tests |
| Python harness | `harness.py`: HookHarness, MockBinDir, PRReviewState | Good — used by test_hooks.py |
| Mock creation (harness) | `harness.sh`: setup_gh_git_mocks, setup_mock_dir | Good — but only used by harness-based tests |

### Needs Building

| Component | What | Why it doesn't exist yet |
|---|---|---|
| `setup_test_env()` | Shared function: creates STATE_DIR, mock gh (returns OPEN), exports PATH | Each file creates its own independently |
| `create_state()` in test-helpers.sh | Shared state file creation with mandatory BRANCH field | 4 files have identical copies; harness.py had a buggy copy |
| `cleanup_test_env()` | Shared teardown: removes STATE_DIR + mock dir | 6 files have identical setup/teardown |
| Decision extractors | `is_denied()` and `is_blocked()` in test-helpers.sh | 4 files define identical helpers under different names |
| `backdate_file()` | Cross-platform file backdating helper | 5 files duplicate the `touch -d` / `touch -t` / `date -v` fallback chain |

## 4. Duplication Inventory

| Pattern | Files | Lines per copy | Total waste | Consolidation |
|---|---|---|---|---|
| STATE_DIR + DEBUG_LOG setup | 6 | 3 | ~18 | `setup_test_env()` |
| Mock gh (returns OPEN) | 8 | 7 | ~56 | `setup_test_env()` |
| `setup()` / `teardown()` | 6 | 6 | ~36 | `reset_state()` / `cleanup_test_env()` |
| `create_state()` | 4 bash + 1 Python | 8 | ~40 | Move to test-helpers.sh |
| Decision extractors | 4 | 3 | ~12 | `is_denied()` / `is_blocked()` in test-helpers.sh |
| `touch -d` backdate pattern | 5 | 2 | ~10 | `backdate_file()` |
| Hook run wrappers with mock PATH | 4 | 6 | ~24 | Can't fully consolidate (different input JSON shapes) |
| **Total** | | | **~196** | |

## 5. Design

### Phase 1: Extract shared helpers to test-helpers.sh

Add these functions to the existing `test-helpers.sh`:

```bash
# Test environment: STATE_DIR, mock gh, PATH
setup_test_env() {
  TEST_STATE_DIR="/tmp/.pr-review-state-test-$$"
  rm -rf "$TEST_STATE_DIR"
  mkdir -p "$TEST_STATE_DIR"
  export STATE_DIR="$TEST_STATE_DIR"
  export DEBUG_LOG="/dev/null"

  TEST_MOCK_DIR=$(mktemp -d)
  cat > "$TEST_MOCK_DIR/gh" << 'MOCK_EOF'
#!/bin/bash
echo "OPEN"
exit 0
MOCK_EOF
  chmod +x "$TEST_MOCK_DIR/gh"
  export PATH="$TEST_MOCK_DIR:$PATH"
}

# Reset state between tests (equivalent to current setup())
reset_state() {
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
}

# Cleanup everything
cleanup_test_env() {
  rm -rf "$TEST_STATE_DIR" "$TEST_MOCK_DIR"
}

# Create PR review state file with mandatory BRANCH
create_state() {
  local pr_url="$1"
  local round="${2:-1}"
  local status="${3:-needs_review}"
  local branch="${4:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
  local filename
  filename=$(echo "$pr_url" | sed 's|https://github\.com/||;s|/pull/|_|;s|/|_|g')
  printf 'PR_URL=%s\nROUND=%s\nSTATUS=%s\nBRANCH=%s\n' \
    "$pr_url" "$round" "$status" "$branch" > "$STATE_DIR/$filename"
}

# Decision extractors
is_denied() {
  echo "$1" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1
}

is_blocked() {
  echo "$1" | jq -e '.decision == "block"' >/dev/null 2>&1
}

# Cross-platform file backdating
backdate_file() {
  local file="$1"
  local hours="${2:-3}"
  touch -d "$hours hours ago" "$file" 2>/dev/null ||
    touch -t "$(date -d "$hours hours ago" +%Y%m%d%H%M.%S 2>/dev/null ||
      date -v-${hours}H +%Y%m%d%H%M.%S)" "$file" 2>/dev/null
}
```

### Phase 2: Update each test file

Each file changes from:

```bash
# BEFORE: ~25 lines of boilerplate per file
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../enforce-pr-review.sh"
STATE_DIR="/tmp/.pr-review-state-test-$$"
export STATE_DIR
export DEBUG_LOG="/dev/null"

GATE_MOCK_DIR=$(mktemp -d)
cat > "$GATE_MOCK_DIR/gh" << 'MOCK'
#!/bin/bash
echo "OPEN"
exit 0
MOCK
chmod +x "$GATE_MOCK_DIR/gh"

setup() { rm -rf "$STATE_DIR"; mkdir -p "$STATE_DIR"; }
teardown() { rm -rf "$STATE_DIR"; }

create_state() { ... 8 lines ... }
run_gate() { ... 4 lines ... }
is_denied() { ... 2 lines ... }
```

To:

```bash
# AFTER: ~5 lines
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(dirname "$0")/../enforce-pr-review.sh"
setup_test_env

run_gate() {
  local input=$(jq -n --arg cmd "$1" '{"tool_input":{"command":$cmd}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}
```

Note: `run_gate`/`run_stop_hook`/`run_tool_gate` stay per-file because they have different input JSON shapes. But they become 2-3 lines each instead of 6+, since PATH and STATE_DIR are already exported by `setup_test_env`.

### Phase 3: Update harness.py

Update `PRReviewState.create_state()` to always include BRANCH (already done in #125, just ensure it stays correct after refactoring).

## 6. What NOT to Do

- **Don't extract test scenarios.** Cross-worktree isolation tests, legacy file tests, and stale file tests are duplicated across files, but they're testing *different hooks* with the same invariant. That's intentional coverage, not duplication. Each hook needs its own test proving it respects the invariant.
- **Don't consolidate hook invocation wrappers.** `run_gate`, `run_stop_hook`, and `run_tool_gate` build different JSON input shapes. A generic wrapper would need parameters that make it harder to read than the 3-line specializations.
- **Don't merge bash and Python tests.** The Python tests cover schema validation and multi-file lifecycle — different value than the bash unit tests.

## 7. Verification

After refactoring, run the full hook test suite:

```bash
bash .claude/kaizen/hooks/tests/run-all-tests.sh
```

**Pass criteria:** Same pass/fail counts as before. Zero regressions.

## 8. Open Questions (Resolved)

1. **Should `setup_test_env` create a mock `git` too?** No — mock `git` stays per-test since only specific tests need git mocking (merge-from-main, branch simulation).

2. **Should `run-all-tests.sh` call `cleanup_test_env` as a safety net?** No — `/tmp` is cleaned on reboot, and the dirs are tiny.

## 9. Implementation Record

**Completed:** Phases 1-2 (Phase 3 was already done in #125).

**What was built:**
- Added 7 shared functions to `test-helpers.sh`: `setup_test_env`, `reset_state`, `cleanup_test_env`, `create_state`, `is_denied`, `is_blocked`, `backdate_file`, `setup_default_gh_mock`
- Updated 7 test files to use shared helpers: `test-enforce-pr-review.sh`, `test-enforce-pr-review-tools.sh`, `test-enforce-pr-review-stop.sh`, `test-state-utils.sh`, `test-pr-review-loop.sh`, `test-review-enforcement-e2e.sh`, `test-integration-pr-lifecycle.sh`
- Net change: +114 / -206 lines (92 lines removed)

**Verification:** Baseline 321 pass / 14 fail → After refactoring 321 pass / 14 fail. Same failed files, same pre-existing failures. Zero regressions.

**Learnings:**
- The e2e test (`test-review-enforcement-e2e.sh`) had `is_stop_blocked` and `is_tool_denied` which are just aliases for `is_blocked` and `is_denied` — kept as thin wrappers for readability in e2e context.
- Integration tests (harness.sh-based) use a different env management pattern (HARNESS_TEMP), so `setup_default_gh_mock` was added to accept a directory parameter rather than forcing all tests into one pattern.
- The `run_gate`/`run_tool_gate`/`run_stop_hook` wrappers stayed per-file as the spec predicted — different JSON input shapes make consolidation harder to read.
