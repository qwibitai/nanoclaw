#!/usr/bin/env bash
# End-to-end: scripted fake codex + scripted spec-check-result writer.
# Drives the orchestrator through a 2-task wave and asserts both files
# land on the base branch via squash commits in ascending task-number order.
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

mkdir -p "$TMP/stubs"

# Fake codex: parses -C <dir> and the prompt. Creates the claimed file in the
# worktree and commits it.
cat > "$TMP/stubs/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
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
  if echo "$prompt" | grep -q 'Create: `a.txt`'; then
    echo a > a.txt
    git add a.txt
    git -c user.email=t@t.t -c user.name=t commit -qm "fake task 1"
  fi
  if echo "$prompt" | grep -q 'Create: `b.txt`'; then
    echo b > b.txt
    git add b.txt
    git -c user.email=t@t.t -c user.name=t commit -qm "fake task 2"
  fi
fi
echo DONE
EOF
chmod +x "$TMP/stubs/codex"

export PATH="$TMP/stubs:$PATH"
GSTACK_HOME="$TMP/.gstack"
export GSTACK_HOME

WORK="$GSTACK_HOME/codex-work/e2e-plan"

# Claude simulator: writes spec-check-result whenever a needs-spec-check appears.
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

"$IMPL" --base main "$THIS_DIR/fixtures/e2e-plan.md"

git -C "$REPO" checkout -q main
test -r "$REPO/a.txt" || { echo "FAIL: a.txt missing"; exit 1; }
test -r "$REPO/b.txt" || { echo "FAIL: b.txt missing"; exit 1; }

# Ascending task-number merge order: task 1 first (older), task 2 second (newer).
# git log -2 emits newest first; reverse via awk for deterministic order.
last2="$(git -C "$REPO" log --format='%s' -2 | awk '{a[NR]=$0} END{for(i=NR;i>=1;i--) print a[i]}')"
echo "$last2" | head -n 1 | grep -q "task 1: alpha file" || { echo "FAIL: task 1 first commit wrong"; echo "$last2"; exit 1; }
echo "$last2" | tail -n 1 | grep -q "task 2: beta file"  || { echo "FAIL: task 2 second commit wrong"; echo "$last2"; exit 1; }

echo "PASS: test-e2e"
