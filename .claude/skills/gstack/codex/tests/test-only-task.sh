#!/usr/bin/env bash
# Regression: --only-task N runs exactly one task in the plan (across
# whatever wave it lives in) and leaves every other task untouched.
# Covers the round-3 P2 fix that wired --only-task through run-wave +
# merge-wave and the wave-skip logic in codex-implement.
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

cat > "$TMP/plan.md" <<'EOF'
# Only-Task Plan

**Goal:** verify --only-task runs exactly one task and leaves peers alone.

**Architecture:** three tasks across two waves.

**Test command:** `true`

## Parallelization

- Wave 1: Tasks 1, 2
- Wave 2: Task 3

### Task 1: alpha

**Files:**
- Create: `a.txt`

- [ ] **Step 1: create a.txt**

Run: `test -r a.txt`

### Task 2: beta

**Files:**
- Create: `b.txt`

- [ ] **Step 1: create b.txt**

Run: `test -r b.txt`

### Task 3: gamma

**Files:**
- Create: `g.txt`

- [ ] **Step 1: create g.txt**

Run: `test -r g.txt`
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
  if echo "$prompt" | grep -q 'Create: `g.txt`'; then echo g > g.txt; fi
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

# Spec check simulator.
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

# Run with --only-task 2 (beta, which lives in Wave 1 alongside alpha).
# Expected: only b.txt lands on main; a.txt and g.txt are NOT created.
"$IMPL" --base main --only-task 2 "$TMP/plan.md" > "$TMP/run.log" 2>&1 || {
  echo "FAIL: --only-task run exited non-zero"
  cat "$TMP/run.log"
  exit 1
}

cd "$REPO" && git checkout -q main
test -r b.txt || { echo "FAIL: b.txt missing — --only-task 2 did not run"; exit 1; }
test ! -r a.txt || { echo "FAIL: a.txt was created — task 1 should not have run"; exit 1; }
test ! -r g.txt || { echo "FAIL: g.txt was created — task 3 (Wave 2) should not have run"; exit 1; }

# State should show:
#   task 2 merged, task 1 + task 3 still pending/dispatched.
#   waves should NOT both be completed (only task 2 ran).
t2="$(jq -r '.waves[0].tasks | map(select(.num == 2))[0].status' "$WORK/state.json")"
[ "$t2" = "merged" ] || { echo "FAIL: task 2 status should be merged, got $t2"; exit 1; }
t1="$(jq -r '.waves[0].tasks | map(select(.num == 1))[0].status' "$WORK/state.json")"
[ "$t1" != "merged" ] || { echo "FAIL: task 1 should NOT be merged (got $t1)"; exit 1; }
t3="$(jq -r '.waves[1].tasks | map(select(.num == 3))[0].status' "$WORK/state.json")"
[ "$t3" != "merged" ] || { echo "FAIL: task 3 should NOT be merged (got $t3)"; exit 1; }

echo "PASS: test-only-task"
