#!/usr/bin/env bash
# Regression for round-9 P1: --resume of a task in claude-fallback status
# must preserve the subagent's in-progress worktree + fallback markers,
# NOT wipe them and restart from codex attempt 1.
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
# Resume-Fallback Test

**Goal:** --resume of claude-fallback task preserves subagent work.

**Architecture:** one task, one wave.

**Test command:** `true`

## Parallelization

- Wave 1: Task 1

### Task 1: alpha

**Files:**
- Create: `a.txt`

- [ ] **Step 1: create a.txt**

Run: `test -r a.txt`
EOF

# Stub codex — `codex exec` (implementer) MUST NOT be called on fallback
# resume. `codex review` (Stage 2 gate) IS expected to run.
mkdir -p "$TMP/stubs"
cat > "$TMP/stubs/codex" <<'EOF'
#!/usr/bin/env bash
# First arg is the subcommand (exec, review, ...).
if [ "${1:-}" = "exec" ]; then
  echo "CODEX EXEC CALLED — THIS SHOULD NOT HAPPEN ON FALLBACK RESUME" >> "$CODEX_CALL_LOG"
  echo DONE
elif [ "${1:-}" = "review" ]; then
  # Clean review output (no [P1], [P0], FAIL, or blocking-issue markers).
  echo "review: no issues found"
else
  echo DONE
fi
EOF
chmod +x "$TMP/stubs/codex"
export CODEX_CALL_LOG="$TMP/codex-exec-called.log"
: > "$CODEX_CALL_LOG"
export PATH="$TMP/stubs:$PATH"
GSTACK_HOME="$TMP/.gstack"
export GSTACK_HOME
_plan_abs="$TMP/plan.md"
_repo_id="$(cd "$REPO" && git rev-parse --show-toplevel | xargs basename)"
_hash="$(printf '%s' "$_plan_abs" | shasum -a 1 | cut -c1-8)"
WORK="$GSTACK_HOME/codex-work/${_repo_id}--plan--${_hash}"

# Pre-stage: task is mid-claude-fallback. Worktree exists with subagent's
# completed edits; needs-claude-fallback marker exists (the subagent work
# has been handed off but no result yet written).
mkdir -p "$WORK"
"$STATEBIN" init "$WORK" \
  --plan-path "$TMP/plan.md" \
  --plan-sha "$(shasum -a 256 "$TMP/plan.md" | cut -d' ' -f1)" \
  --base-ref main --base-sha "$(git rev-parse HEAD)" \
  --waves '[{"wave":1,"tasks":[1]}]' \
  --tasks '[{"num":1,"slug":"alpha"}]'

"$WTHELP" setup "$WORK" alpha main > /dev/null
# The subagent has already written the correct output; just needs the
# fallback-result to be written to accept it.
(cd "$WORK/alpha" && echo alpha > a.txt && git -c user.email=s@s.s -c user.name=s add -A && git -c user.email=s@s.s -c user.name=s commit -qm "subagent edit")

echo '{"wave":1,"task":1,"slug":"alpha","worktree_path":"'"$WORK/alpha"'","base":"main","findings_file":"","plan_json":"","requested_at":"now"}' > "$WORK/needs-claude-fallback.1.1.json"

"$STATEBIN" set-status "$WORK" --wave 1 --task 1 --status claude-fallback

# Simulator writes fallback-result = DONE (not spec-check — this test
# doesn't exercise that path) and responds to any spec-check marker too.
(
  while :; do
    for f in "$WORK"/needs-claude-fallback.*.json; do
      [ -r "$f" ] || continue
      out="$(echo "$f" | sed 's/needs-claude-fallback\./claude-fallback-result./')"
      printf '{"status":"DONE","summary":"ok","completed_at":"now"}\n' > "$out.tmp"
      mv "$out.tmp" "$out"
      rm -f "$f"
    done
    for f in "$WORK"/needs-spec-check.*.json; do
      [ -r "$f" ] || continue
      out="$(echo "$f" | sed 's/needs-spec-check\./spec-check-result./')"
      printf '{"verdict":"PASS","findings_text":"ok","completed_at":"now"}\n' > "$out.tmp"
      mv "$out.tmp" "$out"
      rm -f "$f"
    done
    sleep 1
  done
) &
SIM_PID=$!

# Resume. Must NOT re-run codex; must consume the existing fallback
# handoff + run the gate against the subagent's worktree.
"$IMPL" --base main --resume "$TMP/plan.md" > "$TMP/run.log" 2>&1 || {
  echo "FAIL: resume exited non-zero"
  cat "$TMP/run.log"
  exit 1
}

# Verify: codex was NEVER called.
if [ -s "$CODEX_CALL_LOG" ]; then
  echo "FAIL: codex was dispatched on claude-fallback resume (should have skipped ladder)"
  echo "--- codex call log:"
  cat "$CODEX_CALL_LOG"
  echo "--- run.log:"
  cat "$TMP/run.log"
  echo "--- state.json:"
  jq '.waves[0].tasks[0]' "$WORK/state.json"
  exit 1
fi

# Verify: a.txt landed on main with the subagent's content.
cd "$REPO" && git checkout -q main
test -r a.txt || { echo "FAIL: a.txt missing after resume"; exit 1; }
grep -q "^alpha$" a.txt || { echo "FAIL: a.txt content wrong"; exit 1; }

# Verify wave state.
w_state="$(jq -r '.waves[0].status' "$WORK/state.json")"
[ "$w_state" = "completed" ] || { echo "FAIL: wave not completed ($w_state)"; exit 1; }

echo "PASS: test-resume-claude-fallback"
