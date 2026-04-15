#!/usr/bin/env bash
set -euo pipefail
THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
DISPATCH="$THIS_DIR/../bin/codex-dispatch-task"
FAKE="$THIS_DIR/codex-fake"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

WT="$TMP/wt"; mkdir -p "$WT"
LOGDIR="$TMP/logs"; mkdir -p "$LOGDIR"

cat > "$TMP/responses.jsonl" <<'EOF'
{"type":"message","text":"working..."}
{"type":"final","text":"all good\nDONE"}
EOF
echo "exit 0" > "$TMP/exit"

CODEX_BIN="$FAKE" \
CODEX_FAKE_RESPONSES="$TMP/responses.jsonl" \
CODEX_FAKE_EXIT_FILE="$TMP/exit" \
  "$DISPATCH" \
    --worktree "$WT" \
    --log "$LOGDIR/alpha.log" \
    --prompt-file <(echo "minimal prompt") \
    --reasoning high \
    --session-file "$TMP/alpha.sid" \
  > "$TMP/dispatch.out"

status="$(cat "$TMP/dispatch.out")"
[ "$status" = "DONE" ] || { echo "FAIL: status=$status"; exit 1; }
test -r "$LOGDIR/alpha.log" || { echo "FAIL: log not written"; exit 1; }

cat > "$TMP/responses.jsonl" <<'EOF'
{"type":"final","text":"can't proceed\nBLOCKED"}
EOF
echo "exit 0" > "$TMP/exit"

CODEX_BIN="$FAKE" \
CODEX_FAKE_RESPONSES="$TMP/responses.jsonl" \
CODEX_FAKE_EXIT_FILE="$TMP/exit" \
  "$DISPATCH" \
    --worktree "$WT" \
    --log "$LOGDIR/beta.log" \
    --prompt-file <(echo "p") \
    --reasoning high \
    --session-file "$TMP/beta.sid" \
  > "$TMP/out"

[ "$(cat "$TMP/out")" = "BLOCKED" ] || { echo "FAIL"; exit 1; }

echo "PASS: test-dispatch-task"
