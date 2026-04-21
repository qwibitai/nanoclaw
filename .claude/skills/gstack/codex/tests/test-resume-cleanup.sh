#!/usr/bin/env bash
# Regression: --resume of an interrupted task (status dispatched|gate-check)
# force-tears-down the partial worktree + wipes scratch before re-dispatching.
# Without this fix, stale files from the crashed run would leak into the new
# attempt 1 and produce spurious passes/failures.
#
# Covers FOLLOWUPS #2.
set -euo pipefail

THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
IMPL="$THIS_DIR/../bin/codex-implement"
STATEBIN="$THIS_DIR/../bin/codex-state"
WTHELP="$THIS_DIR/../bin/codex-worktree"
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

cat > "$TMP/plan.md" <<'EOF'
# Resume Cleanup Test

**Goal:** verify interrupted --resume force-cleans partial state.

**Architecture:** single task.

**Test command:** `true`

## Parallelization

- Wave 1: Task 1

### Task 1: alpha

**Files:**
- Create: `a.txt`

- [ ] **Step 1: create a.txt**

Run: `test -r a.txt`
EOF

# Stage 1: codex writes the CORRECT content.
# Stage 2: (not exercised here — this test is about resume cleanup, not gate)
mkdir -p "$TMP/stubs"
cat > "$TMP/stubs/codex" <<'EOF'
#!/usr/bin/env bash
WT=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-C" ]; then WT="$a"; fi
  prev="$a"
done
if [ -n "$WT" ] && [ -d "$WT" ]; then
  cd "$WT"
  # Write the EXPECTED content (not the stale content).
  echo alpha > a.txt
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

# Pre-stage: simulate a crashed run that left a partial task worktree with
# STALE content ("stale-partial") and various scratch files.
mkdir -p "$WORK"
"$STATEBIN" init "$WORK" \
  --plan-path "$TMP/plan.md" \
  --plan-sha "$(shasum -a 256 "$TMP/plan.md" | cut -d' ' -f1)" \
  --base-ref main --base-sha "$(git rev-parse HEAD)" \
  --waves '[{"wave":1,"tasks":[1]}]' \
  --tasks '[{"num":1,"slug":"alpha"}]'

"$WTHELP" setup "$WORK" alpha main > /dev/null

# Simulate stale partial edit.
echo "stale-partial-content-from-crashed-run" > "$WORK/alpha/a.txt"

# Simulate stale scratch files from the crashed attempt.
echo "stale-session-id" > "$WORK/sid.1.1"
echo "stale prompt" > "$WORK/prompt.1.1.txt"
echo "stale findings" > "$WORK/findings.1.1.1.txt"
echo "{}" > "$WORK/needs-spec-check.1.1.1.json"
echo "{}" > "$WORK/spec-check-result.1.1.1.json"

# Mark the task as dispatched (mid-crash state).
"$STATEBIN" set-status "$WORK" --wave 1 --task 1 --status dispatched

# Claude simulator for spec check.
(
  while :; do
    for f in "$WORK"/needs-spec-check.*.json; do
      [ -r "$f" ] || continue
      # Skip our stale pre-seed by checking the file size; real markers are
      # >50 bytes. Stale is "{}" = 2 bytes.
      sz="$(wc -c < "$f" | tr -d ' ')"
      [ "$sz" -lt 50 ] && continue
      result="$(echo "$f" | sed 's/needs-spec-check\./spec-check-result./')"
      printf '{"verdict":"PASS","findings_text":"ok","completed_at":"now"}\n' > "$result.tmp"
      mv "$result.tmp" "$result"
      rm -f "$f"
    done
    sleep 1
  done
) &
SIM_PID=$!

# Resume. The force-cleanup branch in process_one should fire because the
# task is non-terminal (status=dispatched) and the worktree directory exists.
set +e
"$IMPL" --base main --resume "$TMP/plan.md" > "$TMP/run.log" 2>&1
rc=$?
set -e

[ "$rc" -eq 0 ] || { echo "FAIL: resume exited $rc"; cat "$TMP/run.log"; exit 1; }

# The squash commit should have landed on main with the CORRECT content.
cd "$REPO" && git checkout -q main
grep -q "^alpha$" a.txt || {
  echo "FAIL: a.txt has stale content — force-cleanup did not fire"
  echo "  expected 'alpha', got: $(cat a.txt)"
  exit 1
}

# Wave should be completed.
w_state="$(jq -r '.waves[0].status' "$WORK/state.json")"
[ "$w_state" = "completed" ] || { echo "FAIL: wave not completed ($w_state)"; exit 1; }

echo "PASS: test-resume-cleanup"
