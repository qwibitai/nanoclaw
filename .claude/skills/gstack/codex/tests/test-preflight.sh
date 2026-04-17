#!/usr/bin/env bash
set -euo pipefail
THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
IMPL="$THIS_DIR/../bin/codex-implement"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

cd "$TMP" && git init -q && git config user.email t@t.t && git config user.name t
echo a > a.txt && git add a.txt && git commit -qm init
git checkout -qb main

# Make `codex` findable by preflight (even though dry-run skips it) via a stub.
mkdir -p "$TMP/stubs"
cat > "$TMP/stubs/codex" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/stubs/codex"
export PATH="$TMP/stubs:$PATH"

# Dirty tree: full run should refuse (but dry-run should not — verify below)
echo dirt > dirt.txt

# Non-dry-run must refuse
if GSTACK_HOME="$TMP/.gstack" "$IMPL" "$THIS_DIR/fixtures/happy.md" 2> "$TMP/err"; then
  echo "FAIL: expected refusal on dirty tree"; cat "$TMP/err"; exit 1
fi
grep -q "clean" "$TMP/err" || { echo "FAIL: missing 'clean' in err"; cat "$TMP/err"; exit 1; }

# Clean the tree
rm dirt.txt

# Dry-run should parse + print summary, no dispatch, exit 0.
GSTACK_HOME="$TMP/.gstack" "$IMPL" --dry-run "$THIS_DIR/fixtures/happy.md" > "$TMP/out"

grep -q "waves: 2" "$TMP/out" || { echo "FAIL: summary shape"; cat "$TMP/out"; exit 1; }
grep -q "Wave 1: 2 task(s)" "$TMP/out" || { echo "FAIL: wave 1 line"; cat "$TMP/out"; exit 1; }

echo "PASS: test-preflight"
