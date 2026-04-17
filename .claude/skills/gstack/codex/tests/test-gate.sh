#!/usr/bin/env bash
set -euo pipefail
THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE="$THIS_DIR/../bin/codex-gate"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Build a toy worktree: a git repo with a trivial test cmd
WT="$TMP/wt"; mkdir -p "$WT"
(cd "$WT" && git init -q && git config user.email t@t.t && git config user.name t
 echo ok > marker.txt && git add marker.txt && git commit -qm init)

# Stub `codex` so the real codex-gate-review emits PASS (no severity markers).
mkdir -p "$TMP/fakes"
cat > "$TMP/fakes/codex" <<'EOF'
#!/usr/bin/env bash
# Pretend to be `codex review`: print a clean output with no [P0]/[P1]/FAIL markers.
echo "no issues found"
EOF
chmod +x "$TMP/fakes/codex"
export CODEX_BIN="$TMP/fakes/codex"

WORK="$TMP/work"; mkdir -p "$WORK"

# Pre-write the spec-check-result so Stage 3 returns immediately.
cat > "$WORK/spec-check-result.1.1.json" <<'EOF'
{"verdict":"PASS","findings_text":"all spec requirements met","completed_at":"now"}
EOF

"$GATE" \
  --worktree "$WT" \
  --work-dir "$WORK" \
  --wave 1 --task 1 --task-slug alpha \
  --base main \
  --test-cmd "true" \
  --spec-check-poll-seconds 1 \
  > "$TMP/out"

grep -q '^PASS$' "$TMP/out" || { echo "FAIL: expected PASS"; cat "$TMP/out"; exit 1; }

echo "PASS: test-gate (happy-path only; retry paths exercised in e2e)"
