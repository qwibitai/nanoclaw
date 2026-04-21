#!/usr/bin/env bash
# Regression: codex attempts 1-3 BLOCKED → needs-claude-fallback marker →
# fallback DONE → re-gate passes → task accepted. Verifies the
# marker-protocol fallback path end-to-end.
set -euo pipefail

THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
IMPL="$THIS_DIR/../bin/codex-implement"
TMP="$(mktemp -d)"
SIM_PID=""
FB_PID=""
cleanup() {
  if [ -n "$SIM_PID" ]; then kill "$SIM_PID" 2>/dev/null || true; fi
  if [ -n "$FB_PID" ]; then kill "$FB_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

REPO="$TMP/repo"
mkdir -p "$REPO"
cd "$REPO" && git init -q && git config user.email t@t.t && git config user.name t
echo base > base.txt && git add base.txt && git commit -qm init
git checkout -qb main

cat > "$TMP/plan.md" <<'EOF'
# Claude Fallback Test

**Goal:** verify codex attempts 1-3 BLOCKED escalate to needs-claude-fallback.

**Architecture:** single task. Codex-fake always returns BLOCKED.

**Test command:** `true`

## Parallelization

- Wave 1: Task 1

### Task 1: alpha

**Files:**
- Create: `a.txt`

- [ ] **Step 1: create a.txt**

Run: `test -r a.txt`
EOF

# Stub codex: always say BLOCKED (codex itself can't make progress).
mkdir -p "$TMP/stubs"
cat > "$TMP/stubs/codex" <<'EOF'
#!/usr/bin/env bash
echo "cannot make progress"
echo BLOCKED
EOF
chmod +x "$TMP/stubs/codex"
export PATH="$TMP/stubs:$PATH"
GSTACK_HOME="$TMP/.gstack"
export GSTACK_HOME
_plan_abs="$TMP/plan.md"
_repo_id="$(cd "$REPO" && git rev-parse --show-toplevel | xargs basename)"
_hash="$(printf '%s' "$_plan_abs" | shasum -a 1 | cut -c1-8)"
WORK="$GSTACK_HOME/codex-work/${_repo_id}--plan--${_hash}"

# Spec-check simulator (not actually reached, but armed just in case).
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

# Fallback simulator: when needs-claude-fallback appears, write the file
# that the task needs (simulating Claude-as-implementer doing the work),
# then write claude-fallback-result = DONE so run-wave re-runs the gate.
saw_fallback_marker=0
(
  while :; do
    for f in "$WORK"/needs-claude-fallback.*.json; do
      [ -r "$f" ] || continue
      wt="$(jq -r '.worktree_path' "$f")"
      # Simulate Claude writing the missing file.
      echo a > "$wt/a.txt"
      (cd "$wt" && git -c user.email=c@c.c -c user.name=c add -A && git -c user.email=c@c.c -c user.name=c commit -qm "claude fallback")
      # Write success result.
      result="$(echo "$f" | sed 's/needs-claude-fallback\./claude-fallback-result./')"
      printf '{"status":"DONE","summary":"ok","completed_at":"now"}\n' > "$result.tmp"
      mv "$result.tmp" "$result"
      rm -f "$f"
      # Signal marker observed.
      touch "$TMP/saw-fallback-marker"
    done
    sleep 1
  done
) &
FB_PID=$!

# Run — expect success after claude-fallback triggers.
"$IMPL" --base main "$TMP/plan.md" > "$TMP/run.log" 2>&1 || {
  echo "FAIL: run exited non-zero"
  cat "$TMP/run.log"
  exit 1
}

# Verify the fallback path actually fired (not just ran through happy path).
test -r "$TMP/saw-fallback-marker" || {
  echo "FAIL: fallback marker was never observed — retry ladder did not escalate to claude"
  exit 1
}

# Verify the task shipped.
cd "$REPO" && git checkout -q main
test -r a.txt || { echo "FAIL: a.txt missing — fallback path didn't merge"; exit 1; }

# State should show task passed-gate or merged (terminal good).
t1="$(jq -r '.waves[0].tasks[0].status' "$WORK/state.json")"
case "$t1" in
  merged|passed-gate) : ;;
  *) echo "FAIL: task status should be merged|passed-gate, got $t1"; exit 1 ;;
esac

echo "PASS: test-claude-fallback"
