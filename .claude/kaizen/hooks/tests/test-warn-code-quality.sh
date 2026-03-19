#!/bin/bash
# Tests for warn-code-quality.sh hook (kaizen #89)
source "$(dirname "$0")/test-helpers.sh"

HOOK="$(cd "$(dirname "$0")/.." && pwd)/warn-code-quality.sh"
TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# Set up a git repo for staged file testing
REPO_DIR="$TMPDIR_TEST/repo"
mkdir -p "$REPO_DIR/src"
cd "$REPO_DIR"
git init -q
git config user.email "test@test.com"
git config user.name "Test"
echo "init" > README.md
git add README.md
git commit -q -m "init"

run_commit_hook() {
  local input
  input=$(jq -n '{"tool_input":{"command":"git commit -m \"test\""}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

run_non_commit_hook() {
  local cmd="$1"
  local input
  input=$(jq -n --arg c "$cmd" '{"tool_input":{"command":$c}}')
  echo "$input" | bash "$HOOK" 2>/dev/null
}

echo "Testing warn-code-quality.sh"
echo ""

echo "=== Mock count checks ==="

# Test 1: Non-commit command — no output
echo "1. Non-commit command produces no output"
OUTPUT=$(run_non_commit_hook "git status")
assert_eq "non-commit silent" "" "$OUTPUT"

# Test 2: git commit with no staged test files
echo "2. Commit with no staged test files"
echo "change" > "$REPO_DIR/src/index.ts"
git add src/index.ts
OUTPUT=$(run_commit_hook)
assert_eq "no test files silent" "" "$OUTPUT"
git reset -q HEAD src/index.ts

# Test 3: Staged test file with 2 mocks — under threshold
echo "3. Staged test with 2 mocks (under threshold)"
cat > "$REPO_DIR/src/clean.test.ts" << 'EOF'
import { vi } from 'vitest';
vi.mock('./a');
vi.mock('./b');
EOF
git add src/clean.test.ts
OUTPUT=$(run_commit_hook)
assert_not_contains "2 mocks no warning" "mocks" "$OUTPUT"
git reset -q HEAD src/clean.test.ts

# Test 4: Staged test file with 5 mocks — over threshold, WARNING
echo "4. Staged test with 5 mocks (over threshold)"
cat > "$REPO_DIR/src/heavy.test.ts" << 'EOF'
import { vi } from 'vitest';
vi.mock('./a');
vi.mock('./b');
vi.mock('./c');
vi.mock('./d');
vi.mock('./e');
EOF
git add src/heavy.test.ts
OUTPUT=$(run_commit_hook)
assert_contains "warns on 5 mocks" "heavy.test.ts" "$OUTPUT"
assert_contains "shows mock count" "5 mocks" "$OUTPUT"
git reset -q HEAD src/heavy.test.ts

# Test 5: jest.mock also counted
echo "5. jest.mock calls are counted"
cat > "$REPO_DIR/src/jest.test.js" << 'EOF'
jest.mock('./a');
jest.mock('./b');
jest.mock('./c');
jest.mock('./d');
EOF
git add src/jest.test.js
OUTPUT=$(run_commit_hook)
assert_contains "warns on jest.mock" "jest.test.js" "$OUTPUT"
git reset -q HEAD src/jest.test.js

echo ""
echo "=== File length checks ==="

# Test 6: Short source file — no warning
echo "6. Short source file (under 500 lines)"
seq 1 100 | sed 's/^/const x = /' > "$REPO_DIR/src/small.ts"
git add src/small.ts
OUTPUT=$(run_commit_hook)
assert_not_contains "short file silent" "lines" "$OUTPUT"
git reset -q HEAD src/small.ts

# Test 7: Long source file — WARNING
echo "7. Long source file (over 500 lines)"
seq 1 600 | sed 's/^/const x = /' > "$REPO_DIR/src/bloated.ts"
git add src/bloated.ts
OUTPUT=$(run_commit_hook)
assert_contains "warns on long file" "bloated.ts" "$OUTPUT"
assert_contains "shows line count" "600 lines" "$OUTPUT"
git reset -q HEAD src/bloated.ts

# Test 8: Long test file does NOT trigger line warning (only mock check applies to tests)
echo "8. Long test file only triggers mock check, not line check"
seq 1 600 | sed 's/^/\/\/ line /' > "$REPO_DIR/src/long.test.ts"
git add src/long.test.ts
OUTPUT=$(run_commit_hook)
assert_not_contains "test file no line warning" "lines" "$OUTPUT"
git reset -q HEAD src/long.test.ts

echo ""
echo "=== Combined checks ==="

# Test 9: Both mock and line warnings together
echo "9. Both warnings fire together"
cat > "$REPO_DIR/src/coupled.test.ts" << 'EOF'
import { vi } from 'vitest';
vi.mock('./a'); vi.mock('./b'); vi.mock('./c'); vi.mock('./d');
EOF
# Need 4 mocks on separate lines
cat > "$REPO_DIR/src/coupled.test.ts" << 'EOF'
import { vi } from 'vitest';
vi.mock('./a');
vi.mock('./b');
vi.mock('./c');
vi.mock('./d');
EOF
seq 1 600 | sed 's/^/const x = /' > "$REPO_DIR/src/big.ts"
git add src/coupled.test.ts src/big.ts
OUTPUT=$(run_commit_hook)
assert_contains "mock warning present" "coupled.test.ts" "$OUTPUT"
assert_contains "line warning present" "big.ts" "$OUTPUT"
git reset -q HEAD src/coupled.test.ts src/big.ts

# Test 10: Always exits 0
echo "10. Always exits 0 even with warnings"
git add src/bloated.ts src/heavy.test.ts 2>/dev/null
INPUT=$(jq -n '{"tool_input":{"command":"git commit -m \"test\""}}')
echo "$INPUT" | bash "$HOOK" >/dev/null 2>&1
assert_eq "exit code is 0" "0" "$?"
git reset -q HEAD -- . 2>/dev/null

echo ""
echo "=== PR path ==="

# Test 11: gh pr create does NOT fire mock/line checks
echo "11. PR create does not fire commit-only checks"
# Stage files so they exist, but PR path uses origin/main diff (which will be empty in test repo)
OUTPUT=$(run_non_commit_hook "gh pr create --title test")
assert_not_contains "no mock warning on PR" "mocks" "$OUTPUT"
assert_not_contains "no line warning on PR" "lines" "$OUTPUT"

# Test 12: gh pr create triggers (exits 0 even without origin/main)
echo "12. PR create path exits 0 gracefully"
INPUT=$(jq -n '{"tool_input":{"command":"gh pr create --title test"}}')
echo "$INPUT" | bash "$HOOK" >/dev/null 2>&1
assert_eq "PR create exits 0" "0" "$?"

print_results
