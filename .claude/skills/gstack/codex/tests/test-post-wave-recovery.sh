#!/usr/bin/env bash
# Regression: post-wave global test fails → worktrees/branches preserved →
# --resume after fix re-runs only the global test → wave completes cleanly.
#
# Covers FOLLOWUPS #1 (defer teardown until global test green).
set -euo pipefail

THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
IMPL="$THIS_DIR/../bin/codex-implement"
TMP="$(mktemp -d)"
SIM_PID=""
cleanup() {
  if [ -n "$SIM_PID" ]; then kill "$SIM_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

REPO="$TMP/repo"
mkdir -p "$REPO"
cd "$REPO" && git init -q && git config user.email t@t.t && git config user.name t
echo base > base.txt && git add base.txt && git commit -qm init
git checkout -qb main

# Plan with a global test that checks for a "gate-open" sentinel file.
# On the first run, the file doesn't exist → global test fails.
# After we touch the file, --resume should re-run only the global test.
cat > "$TMP/plan.md" <<EOF
# Recovery Test Plan

**Goal:** verify post-wave global-test recovery path.

**Architecture:** two tasks, one wave; global test checks for gate-open.

**Test command:** \`test -r "$TMP/gate-open"\`

## Parallelization

- Wave 1: Tasks 1, 2

### Task 1: alpha

**Files:**
- Create: \`a.txt\`

- [ ] **Step 1: create a.txt**

Run: \`test -r a.txt\`

### Task 2: beta

**Files:**
- Create: \`b.txt\`

- [ ] **Step 1: create b.txt**

Run: \`test -r b.txt\`
EOF

mkdir -p "$TMP/stubs"
cat > "$TMP/stubs/codex" <<'EOF'
#!/usr/bin/env bash
WT=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-C" ]; then WT="$a"; fi
  prev="$a"
done
prompt=""
if [ "$#" -gt 0 ]; then
  eval 'prompt=${'$#'}'
fi
if [ -n "$WT" ] && [ -d "$WT" ]; then
  cd "$WT"
  if echo "$prompt" | grep -q 'Create: `a.txt`'; then echo a > a.txt; fi
  if echo "$prompt" | grep -q 'Create: `b.txt`'; then echo b > b.txt; fi
fi
echo DONE
EOF
chmod +x "$TMP/stubs/codex"
export PATH="$TMP/stubs:$PATH"
GSTACK_HOME="$TMP/.gstack"
export GSTACK_HOME
_plan_abs="$TMP/plan.md"
_repo_id="$(cd "$REPO" && git rev-parse --show-toplevel | xargs basename)"
_hash="$(printf '%s' "$_plan_abs" | shasum -a 1 | cut -c1-8)"
WORK="$GSTACK_HOME/codex-work/${_repo_id}--plan--${_hash}"

# Claude simulator: auto-PASS every spec check.
(
  while :; do
    for f in "$WORK"/needs-spec-check.*.json; do
      [ -r "$f" ] || continue
      result="$(echo "$f" | sed 's/needs-spec-check\./spec-check-result./')"
      printf '{"verdict":"PASS","findings_text":"ok","completed_at":"now"}\n' > "$result.tmp"
      mv "$result.tmp" "$result"
      rm -f "$f"
    done
    sleep 1
  done
) &
SIM_PID=$!

# First run — global test will fail because $TMP/gate-open doesn't exist.
set +e
"$IMPL" --base main "$TMP/plan.md" > "$TMP/run1.log" 2>&1
rc1=$?
set -e

[ "$rc1" -ne 0 ] || { echo "FAIL: first run should have exited non-zero"; cat "$TMP/run1.log"; exit 1; }
grep -q "post-wave-global-test-failed" "$TMP/run1.log" || {
  echo "FAIL: expected 'post-wave-global-test-failed' in run1 output"; cat "$TMP/run1.log"; exit 1;
}

# Both tasks should be merged on main.
cd "$REPO" && git checkout -q main
test -r a.txt || { echo "FAIL: a.txt not merged on main"; exit 1; }
test -r b.txt || { echo "FAIL: b.txt not merged on main"; exit 1; }

# Worktrees should STILL exist (deferred teardown).
test -d "$WORK/alpha" || { echo "FAIL: alpha worktree was torn down; should still exist for inspection"; exit 1; }
test -d "$WORK/beta"  || { echo "FAIL: beta worktree was torn down; should still exist for inspection"; exit 1; }

# State should report both tasks merged, wave in_progress (not completed).
w_state="$(jq -r '.waves[0].status' "$WORK/state.json")"
[ "$w_state" = "in_progress" ] || { echo "FAIL: wave status should be in_progress, got $w_state"; exit 1; }
t1="$(jq -r '.waves[0].tasks[0].status' "$WORK/state.json")"
t2="$(jq -r '.waves[0].tasks[1].status' "$WORK/state.json")"
[ "$t1" = "merged" ] || { echo "FAIL: task 1 should be merged, got $t1"; exit 1; }
[ "$t2" = "merged" ] || { echo "FAIL: task 2 should be merged, got $t2"; exit 1; }

# Fix the environment: touch the gate-open file.
touch "$TMP/gate-open"

# --resume should re-run the global test only (no re-dispatch) and complete the wave.
set +e
"$IMPL" --base main --resume "$TMP/plan.md" > "$TMP/run2.log" 2>&1
rc2=$?
set -e

[ "$rc2" -eq 0 ] || { echo "FAIL: resume should succeed; rc=$rc2"; cat "$TMP/run2.log"; exit 1; }

# Wave should now be completed; worktrees torn down.
w_state2="$(jq -r '.waves[0].status' "$WORK/state.json")"
[ "$w_state2" = "completed" ] || { echo "FAIL: wave should be completed post-resume, got $w_state2"; exit 1; }
test ! -d "$WORK/alpha" || { echo "FAIL: alpha worktree should be torn down post-resume"; exit 1; }
test ! -d "$WORK/beta"  || { echo "FAIL: beta worktree should be torn down post-resume"; exit 1; }

echo "PASS: test-post-wave-recovery"
