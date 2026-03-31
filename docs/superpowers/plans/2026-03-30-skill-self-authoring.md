# Skill Self-Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the main group agent to create new skills, validate their structure, update the catalog, and open PRs — the first closed loop of self-modification.

**Architecture:** Three deliverables: (1) a validation script the agent runs before committing, (2) a meta-skill that teaches the agent the full authoring workflow, (3) a CLAUDE.md update pointing the agent to the meta-skill. No new TypeScript, no host-side changes — this is purely in-container tooling and instructions.

**Tech Stack:** Bash (validation script), Markdown (meta-skill), existing `gh` CLI and git for PR workflow.

---

### Task 1: Create the validation script

**Files:**
- Create: `container/skills-catalog/validate-skill.sh`

- [ ] **Step 1: Write the validation script**

Create `container/skills-catalog/validate-skill.sh`:

```bash
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
```

- [ ] **Step 2: Make it executable and test with an existing skill**

```bash
chmod +x container/skills-catalog/validate-skill.sh
./container/skills-catalog/validate-skill.sh local/market-data
```

Expected: `PASSED: skill is valid` with all OK lines.

- [ ] **Step 3: Test with a bad skill to verify failure detection**

```bash
mkdir -p /tmp/test-bad-skill
echo "no frontmatter here" > /tmp/test-bad-skill/SKILL.md
# Temporarily copy to catalog dir for testing
cp -r /tmp/test-bad-skill container/skills-catalog/local/test-bad-skill
./container/skills-catalog/validate-skill.sh local/test-bad-skill || echo "Correctly failed"
rm -rf container/skills-catalog/local/test-bad-skill /tmp/test-bad-skill
```

Expected: FAIL lines for missing name/description, then exit 1.

- [ ] **Step 4: Commit**

```bash
git add container/skills-catalog/validate-skill.sh
git commit -m "feat: add skill validation script for self-authoring pipeline"
```

---

### Task 2: Create the skill-authoring meta-skill

**Files:**
- Create: `container/skills-catalog/local/skill-authoring/SKILL.md`

- [ ] **Step 1: Write the meta-skill**

Create `container/skills-catalog/local/skill-authoring/SKILL.md`:

```markdown
---
name: skill-authoring
description: Create new skills for the NanoClaw agent. Use when asked to "create a skill", "make a skill for X", "add a new capability", or when you notice a workflow you keep repeating that should be codified. Main group only.
---

# Skill Authoring

You can create new skills and add them to the NanoClaw skills catalog. Skills are loaded into containers at launch, giving agents new capabilities.

## When to Create a Skill

- User explicitly asks: "create a skill for X", "can you make that a skill?"
- User repeatedly explains the same workflow and it would benefit from codification
- You identify a reusable pattern that other groups/sessions would benefit from

## Skill Structure

Each skill is a directory under `/workspace/project/container/skills-catalog/local/{skill-name}/` containing:

```
local/my-skill/
├── SKILL.md              # Required — frontmatter + instructions
├── my_script.py          # Optional — supporting code
└── template.md           # Optional — templates, configs, etc.
```

### SKILL.md Format

```markdown
---
name: my-skill
description: One-line description with specific trigger phrases. Use when the user asks to "do X", "analyze Y", or needs Z capability.
---

# My Skill

What this skill does and when to use it.

## Setup (if needed)

Environment variables, installs, prerequisites.

## Usage

Step-by-step instructions with code blocks the agent can copy-paste.
```

### Writing Good Descriptions

The description field is how the skill system decides whether to load your skill. Be specific.

**Good** — specific trigger phrases, clear scope:
```
Fetch real-time quotes, historical OHLCV, and fundamental metrics for stocks. Use when you need current prices, price history, or financial ratios for any ticker.
```

**Bad** — vague, no triggers:
```
Helps with stock stuff.
```

**Good** — actionable triggers:
```
Read and write Notion pages and databases. Use when asked to search Notion, read a page, create notes, update content, or query a database.
```

**Bad** — too broad:
```
Integration with Notion.
```

## Authoring Workflow

### 1. Write the skill files

Create the directory and SKILL.md. Follow existing skills as templates:
- `market-data` — Python script + CLI interface
- `notion` — API integration with setup instructions
- `fundamental-analysis` — Multi-script skill with blended outputs

The skill name MUST be kebab-case (lowercase, hyphens only).

### 2. Validate

Run the validation script from the project root:

```bash
/workspace/project/container/skills-catalog/validate-skill.sh local/my-skill
```

Fix any FAIL items before proceeding.

### 3. Update the catalog

Add an entry to `/workspace/project/container/skills-catalog/catalog.json` in the `skills` array:

```json
{
  "name": "my-skill",
  "source": "local",
  "description": "Same description as SKILL.md frontmatter",
  "categories": ["general"],
  "path": "/skills-catalog/local/my-skill"
}
```

**Categories:**
- `general` — available to all groups (default)
- `coding` — dev-focused groups
- `creative` — creative/design groups
- `engineering` — engineering/simulation groups

Multiple categories are supported: `["general", "coding"]`.

### 4. Open a PR

```bash
cd /workspace/project
git checkout -b feat/skill-my-skill
git add container/skills-catalog/local/my-skill/ container/skills-catalog/catalog.json
git commit -m "feat: add my-skill skill — one-line description"
gh pr create \
  --title "feat: add my-skill skill — one-line description" \
  --body "## New Skill: my-skill

**Description:** What it does and why.

**Categories:** general

**Usage example:** How a user would trigger this.

**Files:**
- \`container/skills-catalog/local/my-skill/SKILL.md\` — skill instructions
- \`container/skills-catalog/catalog.json\` — catalog entry"
```

The user will review and merge the PR. After merge, auto-deploy picks up the change within 2 minutes — the skill will be live in the next container launch.

## Important Notes

- The project mount at `/workspace/project/` is **read-only**. You must work on a git branch and push changes via PR. Do not try to write directly to the project mount.
- Always validate before committing. The validation script catches common mistakes.
- Keep skills focused. One skill = one capability. Don't create mega-skills that do everything.
- Include setup instructions if the skill needs environment variables or pip installs.
```

- [ ] **Step 2: Validate the meta-skill with the validation script**

```bash
./container/skills-catalog/validate-skill.sh local/skill-authoring
```

Expected: `PASSED: skill is valid`

- [ ] **Step 3: Commit**

```bash
git add container/skills-catalog/local/skill-authoring/SKILL.md
git commit -m "feat: add skill-authoring meta-skill"
```

---

### Task 3: Update catalog.json with the new skill

**Files:**
- Modify: `container/skills-catalog/catalog.json`

- [ ] **Step 1: Add the skill-authoring entry to catalog.json**

Add to the `skills` array in `container/skills-catalog/catalog.json`:

```json
{
  "name": "skill-authoring",
  "source": "local",
  "description": "Create new skills for the NanoClaw agent. Use when asked to \"create a skill\", \"make a skill for X\", \"add a new capability\", or when you notice a workflow you keep repeating that should be codified. Main group only.",
  "categories": ["coding"],
  "path": "/skills-catalog/local/skill-authoring"
}
```

Place it alphabetically among the other local skills.

- [ ] **Step 2: Validate the catalog is still valid JSON**

```bash
python3 -c "import json; json.load(open('container/skills-catalog/catalog.json')); print('Valid JSON')"
```

Expected: `Valid JSON`

- [ ] **Step 3: Verify the new skill passes validation (no collision with itself)**

```bash
# Temporarily remove the entry we just added to test collision detection isn't a false positive
./container/skills-catalog/validate-skill.sh local/skill-authoring
```

Expected: `PASSED`

- [ ] **Step 4: Commit**

```bash
git add container/skills-catalog/catalog.json
git commit -m "chore: add skill-authoring to skills catalog"
```

---

### Task 4: Update discord_main CLAUDE.md

**Files:**
- Modify: `groups/discord_main/CLAUDE.md` (create if it doesn't exist)

- [ ] **Step 1: Add skill-authoring pointer to discord_main CLAUDE.md**

The file `groups/discord_main/CLAUDE.md` does not currently exist. Create it with a pointer to the skill-authoring capability:

```markdown
# Discord Main

This is the main control group with elevated privileges.

## Skill Authoring

You can create new skills for the NanoClaw agent. When the user asks you to create a skill, or you identify a workflow that should be codified, use the `skill-authoring` skill in your skills catalog.

The full workflow: write skill files → validate → update catalog → open PR → user reviews & merges → auto-deploy makes it live.

See your `skill-authoring` skill for the complete guide.
```

- [ ] **Step 2: Commit**

```bash
git add groups/discord_main/CLAUDE.md
git commit -m "feat: add discord_main CLAUDE.md with skill-authoring pointer"
```

---

### Task 5: End-to-end validation

- [ ] **Step 1: Verify all files exist and are valid**

```bash
# Validation script exists and is executable
test -x container/skills-catalog/validate-skill.sh && echo "OK: validate-skill.sh executable"

# Meta-skill exists and validates
./container/skills-catalog/validate-skill.sh local/skill-authoring

# Catalog is valid JSON with the new entry
python3 -c "
import json
catalog = json.load(open('container/skills-catalog/catalog.json'))
entry = [s for s in catalog['skills'] if s['name'] == 'skill-authoring' and s['source'] == 'local']
assert len(entry) == 1, f'Expected 1 entry, found {len(entry)}'
print(f'OK: skill-authoring in catalog with categories {entry[0][\"categories\"]}')
"

# discord_main CLAUDE.md exists
test -f groups/discord_main/CLAUDE.md && echo "OK: discord_main CLAUDE.md exists"
```

Expected: All OK lines, no errors.

- [ ] **Step 2: Test validation script catches errors**

```bash
# Create a deliberately bad skill
mkdir -p /tmp/bad-skill-test
echo "no frontmatter" > /tmp/bad-skill-test/SKILL.md
cp -r /tmp/bad-skill-test container/skills-catalog/local/bad-skill-test
./container/skills-catalog/validate-skill.sh local/bad-skill-test 2>&1; echo "Exit: $?"
rm -rf container/skills-catalog/local/bad-skill-test /tmp/bad-skill-test
```

Expected: FAIL lines and exit code 1.

- [ ] **Step 3: Build to verify nothing is broken**

```bash
npm run build
npm test
```

Expected: TypeScript compiles, all tests pass. (No TypeScript was changed, so this is a sanity check.)

- [ ] **Step 4: Commit any fixups, then verify git log**

```bash
git log --oneline -6
```

Expected: 4 new commits (validate script, meta-skill, catalog update, CLAUDE.md).
