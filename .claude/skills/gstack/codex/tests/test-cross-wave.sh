#!/usr/bin/env bash
# Regression: a plan where Wave 2 reads a file that Wave 1 produced.
# Wave 1 must fully merge + tear down before Wave 2's worktrees are
# created, otherwise Wave 2's tasks wouldn't see Wave 1's output.
#
# Exercises: multi-wave ordering, cross-wave artifact visibility,
# per-task stage-1 test fallback (tasks here each have their own Run:).
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
# Cross-Wave Plan

**Goal:** Wave 2 task reads artifact from Wave 1 task.

**Architecture:** Wave 1 writes src.txt; Wave 2 reads src.txt and writes dst.txt.

**Test command:** `test -r dst.txt && grep -q 'derived from: alpha' dst.txt`

## Parallelization

- Wave 1: Task 1
- Wave 2: Task 2

### Task 1: source

**Files:**
- Create: `src.txt`

- [ ] **Step 1: write alpha to src.txt**

Run: `test -r src.txt && grep -q '^alpha$' src.txt`

### Task 2: derived

**Files:**
- Create: `dst.txt`

- [ ] **Step 1: read src.txt, write derived to dst.txt**

Run: `test -r dst.txt && grep -q 'derived from: alpha' dst.txt`
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
  if echo "$prompt" | grep -q 'Create: `src.txt`'; then
    echo alpha > src.txt
  fi
  if echo "$prompt" | grep -q 'Create: `dst.txt`'; then
    # Wave 2 should see Wave 1's src.txt because Wave 2 worktrees are
    # created AFTER Wave 1 squash-merged into main.
    if [ -r src.txt ]; then
      src_content="$(cat src.txt)"
      echo "derived from: $src_content" > dst.txt
    else
      echo "ERROR: src.txt not visible in Wave 2 worktree" >&2
      exit 2
    fi
  fi
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

"$IMPL" --base main "$TMP/plan.md" > "$TMP/run.log" 2>&1 || {
  echo "FAIL: run exited non-zero"
  cat "$TMP/run.log"
  exit 1
}

cd "$REPO" && git checkout -q main
test -r src.txt || { echo "FAIL: src.txt missing"; exit 1; }
test -r dst.txt || { echo "FAIL: dst.txt missing — Wave 2 may not have seen Wave 1 artifact"; exit 1; }
grep -q "^alpha$" src.txt || { echo "FAIL: src.txt content wrong"; exit 1; }
grep -q "derived from: alpha" dst.txt || {
  echo "FAIL: dst.txt does not reference src.txt content"
  cat dst.txt
  exit 1
}

# Both waves should be completed.
w1="$(jq -r '.waves[0].status' "$WORK/state.json")"
w2="$(jq -r '.waves[1].status' "$WORK/state.json")"
[ "$w1" = "completed" ] || { echo "FAIL: wave 1 status $w1"; exit 1; }
[ "$w2" = "completed" ] || { echo "FAIL: wave 2 status $w2"; exit 1; }

echo "PASS: test-cross-wave"
