#!/bin/bash
# Validate a skill directory before committing.
# Usage: ./container/skills-catalog/validate-skill.sh local/my-skill
set -euo pipefail

CATALOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_REL="${1:?Usage: validate-skill.sh <relative-path> (e.g. local/my-skill)}"
SKILL_DIR="${CATALOG_DIR}/${SKILL_REL}"
CATALOG_FILE="${CATALOG_DIR}/catalog.json"

errors=0
warn() { echo "  WARN: $*"; }
fail() { echo "  FAIL: $*"; errors=$((errors + 1)); }
pass() { echo "  OK:   $*"; }

echo "Validating skill: ${SKILL_REL}"
echo "---"

# 1. Directory exists
if [ ! -d "$SKILL_DIR" ]; then
  fail "Directory does not exist: ${SKILL_DIR}"
  exit 1
fi

# 2. SKILL.md exists
SKILL_MD="${SKILL_DIR}/SKILL.md"
if [ ! -f "$SKILL_MD" ]; then
  fail "SKILL.md not found"
  exit 1
fi
pass "SKILL.md exists"

# 3. Frontmatter has name and description
# Parse YAML frontmatter between --- delimiters
NAME=$(sed -n '/^---$/,/^---$/{ /^name:/{ s/^name: *//; s/^["'"'"']//; s/["'"'"']$//; p; } }' "$SKILL_MD")
DESC=$(sed -n '/^---$/,/^---$/{ /^description:/{ s/^description: *//; s/^["'"'"']//; s/["'"'"']$//; p; } }' "$SKILL_MD")

if [ -z "$NAME" ]; then
  fail "Frontmatter missing 'name' field"
else
  pass "Frontmatter has name: ${NAME}"
fi

if [ -z "$DESC" ]; then
  fail "Frontmatter missing 'description' field"
else
  if [ ${#DESC} -lt 20 ]; then
    warn "Description is very short (${#DESC} chars) — aim for specific trigger phrases"
  fi
  pass "Frontmatter has description (${#DESC} chars)"
fi

# 4. Name is kebab-case (lowercase, hyphens, no spaces)
DIRNAME=$(basename "$SKILL_DIR")
if ! echo "$DIRNAME" | grep -qE '^[a-z][a-z0-9-]*$'; then
  fail "Directory name '${DIRNAME}' is not kebab-case (use lowercase letters, numbers, hyphens)"
else
  pass "Directory name is kebab-case"
fi

# 5. Name matches directory
if [ -n "$NAME" ] && [ "$NAME" != "$DIRNAME" ]; then
  warn "Frontmatter name '${NAME}' differs from directory name '${DIRNAME}' — they should match"
fi

# 6. No catalog collision
if [ -f "$CATALOG_FILE" ]; then
  # Check if a local skill with this exact name+path already exists
  EXISTING=$(python3 -c "
import json, sys
catalog = json.load(open('${CATALOG_FILE}'))
for s in catalog.get('skills', []):
    if s.get('source') == 'local' and s.get('name') == '${NAME}':
        print(s['path'])
        break
" 2>/dev/null || true)
  if [ -n "$EXISTING" ]; then
    fail "Catalog already has a local skill named '${NAME}' at ${EXISTING}"
  else
    pass "No catalog collision"
  fi
fi

# 7. Python files parse without syntax errors
for pyfile in "${SKILL_DIR}"/*.py; do
  [ -f "$pyfile" ] || continue
  PYNAME=$(basename "$pyfile")
  if python3 -c "import ast; ast.parse(open('${pyfile}').read())" 2>/dev/null; then
    pass "Python file parses: ${PYNAME}"
  else
    fail "Python syntax error in: ${PYNAME}"
  fi
done

echo "---"
if [ $errors -gt 0 ]; then
  echo "FAILED: ${errors} error(s) found"
  exit 1
else
  echo "PASSED: skill is valid"
  exit 0
fi
