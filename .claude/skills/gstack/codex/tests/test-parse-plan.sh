#!/usr/bin/env bash
set -euo pipefail

THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
PARSER="$THIS_DIR/../bin/codex-parse-plan"
FIX="$THIS_DIR/fixtures"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Happy path
"$PARSER" "$FIX/happy.md" > "$TMP/happy.json"
jq -e '.goal == "test fixture for the parser."' "$TMP/happy.json" > /dev/null
jq -e '.test_command == "echo global-test"' "$TMP/happy.json" > /dev/null
jq -e '.tasks | length == 3' "$TMP/happy.json" > /dev/null
jq -e '.waves | length == 2' "$TMP/happy.json" > /dev/null
jq -e '.waves[0].tasks == [1,2]' "$TMP/happy.json" > /dev/null
jq -e '.waves[1].tasks == [3]' "$TMP/happy.json" > /dev/null
jq -e '.tasks[0].slug == "alpha"' "$TMP/happy.json" > /dev/null
jq -e '.tasks[0].files == ["a.txt"]' "$TMP/happy.json" > /dev/null

# No Parallelization — falls back to serial, exit 0 with warning on stderr
"$PARSER" "$FIX/no-parallelization.md" > "$TMP/np.json" 2> "$TMP/np.err"
grep -q "WARNING.*Parallelization" "$TMP/np.err" || { echo "FAIL: no warning"; exit 1; }
jq -e '.waves == [{"wave":1,"tasks":[1]}]' "$TMP/np.json" > /dev/null

# Duplicate ref — hard error
if "$PARSER" "$FIX/duplicate-task-ref.md" > /dev/null 2> "$TMP/err"; then
  echo "FAIL: expected exit != 0"; exit 1
fi
grep -q "duplicate" "$TMP/err" || { echo "FAIL: bad error msg"; exit 1; }

# Missing ref — hard error
if "$PARSER" "$FIX/missing-task-ref.md" > /dev/null 2> "$TMP/err"; then
  echo "FAIL: expected exit != 0"; exit 1
fi
grep -q "not referenced" "$TMP/err" || { echo "FAIL: bad error msg"; exit 1; }

# Overlapping files — hard error
if "$PARSER" "$FIX/overlapping-files.md" > /dev/null 2> "$TMP/err"; then
  echo "FAIL: expected exit != 0"; exit 1
fi
grep -q "overlapping" "$TMP/err" || { echo "FAIL: bad error msg"; exit 1; }

echo "PASS: test-parse-plan"
