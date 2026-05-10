---
name: check-contribution
description: Pre-flight checks for NanoClaw contributions before submitting a PR. Validates SKILL.md format, skill type consistency, code quality, security, and PR readiness. Run before opening or updating a PR to upstream.
---

# Check Contribution

Validates a NanoClaw skill contribution against CONTRIBUTING.md rules and maintainer quality standards before submitting a PR.

## How it works

**Target detection**: asks which skill to check, or auto-detects from working context.

**Type classification**: auto-detects skill type (feature/utility/operational/container) from directory structure and content.

**Check execution**: runs all applicable checks in five categories — format, type consistency, code quality, security, PR preparation.

**Results**: presents a pass/fail table grouped by category with actionable fix suggestions.

**Upstream check**: optionally searches for existing PRs/issues on the same topic.

Run `/check-contribution` in Claude Code, optionally with a skill name as argument.

## Goal

Catch contribution issues before the maintainer does, reducing review round-trips.

## Operating principles

- Never modify files — this is a read-only diagnostic.
- Use targeted `git`/`grep` commands, not broad file scans.
- Only run checks applicable to the detected skill type.
- Present results clearly: PASS, FAIL, WARN, or N/A with fix suggestions for each issue.

---

# Step 0: Detect target skill

If the user provided a skill name as argument, use it directly. Otherwise, auto-detect:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
REL_PATH=$(pwd | sed "s|^$REPO_ROOT/||")
```

If `$REL_PATH` starts with `.claude/skills/<name>/` or `container/skills/<name>/`, extract that skill name.

If no context detected, use AskUserQuestion: "Which skill should I check?" with options populated from:

```bash
ls -1d .claude/skills/*/ container/skills/*/ 2>/dev/null | sed 's|/||' | sort
```

Store the skill directory path as `SKILL_DIR` and name as `SKILL_NAME`.

Verify the directory exists. If not, stop with: "Directory `$SKILL_DIR` not found."

Verify SKILL.md exists:

```bash
test -f "$SKILL_DIR/SKILL.md" && echo "OK" || echo "MISSING"
```

If missing, stop with: "No SKILL.md found in `$SKILL_DIR`. Every skill must have a SKILL.md."

# Step 1: Classify skill type

Run these checks:

```bash
# Container skill?
echo "$SKILL_DIR" | grep -q "^container/skills/" && echo "IS_CONTAINER" || echo "NOT_CONTAINER"

# Has code files (non-markdown)?
find "$SKILL_DIR" -type f ! -name "SKILL.md" ! -name "*.md" 2>/dev/null | head -5

# References branch merge in early content?
head -60 "$SKILL_DIR/SKILL.md" | grep -qi "merge\|git fetch\|git branch"
```

**Classification logic:**

| Condition | Type |
|-----------|------|
| Path starts with `container/skills/` | **container** |
| Has non-markdown files AND SKILL.md references `${CLAUDE_SKILL_DIR}` | **utility** |
| SKILL.md early content references branch merge/fetch | **feature** |
| Only SKILL.md (and .md files), no branch references | **operational** |
| Ambiguous (e.g., has code files AND merge references) | Ask the user |

If ambiguous, use AskUserQuestion to ask the user which type they intended, showing the evidence.

Store as `SKILL_TYPE`.

# Step 2: SKILL.md format checks

These apply to **all** skill types.

**2a. Frontmatter `name` field:**
```bash
head -10 "$SKILL_DIR/SKILL.md" | grep -q "^name:" && echo "PASS" || echo "FAIL"
```

**2b. Frontmatter `description` field:**
```bash
head -10 "$SKILL_DIR/SKILL.md" | grep -q "^description:" && echo "PASS" || echo "FAIL"
```

**2c. Name format (lowercase, alphanumeric + hyphens, max 64 chars):**
```bash
SKILL_FM_NAME=$(sed -n 's/^name: *//p' "$SKILL_DIR/SKILL.md" | head -1 | tr -d '"' | tr -d "'")
echo "$SKILL_FM_NAME" | grep -qE '^[a-z0-9-]{1,64}$' && echo "PASS ($SKILL_FM_NAME)" || echo "FAIL ($SKILL_FM_NAME)"
```

**2d. Under 500 lines:**
```bash
LINES=$(wc -l < "$SKILL_DIR/SKILL.md")
[ "$LINES" -lt 500 ] && echo "PASS ($LINES lines)" || echo "FAIL ($LINES lines)"
```

**2e. Code in separate files** (utility skills only — N/A for others):
```bash
# Only for utility skills:
CODE_FILES=$(find "$SKILL_DIR" -type f ! -name "SKILL.md" ! -name "*.md" 2>/dev/null | head -1)
[ -n "$CODE_FILES" ] && echo "PASS" || echo "FAIL (no code files found — reclassify as operational?)"
```

**2f. Uses `${CLAUDE_SKILL_DIR}`** (utility skills only — N/A for others):
```bash
# Only for utility skills:
grep -q 'CLAUDE_SKILL_DIR' "$SKILL_DIR/SKILL.md" && echo "PASS" || echo "FAIL"
```

# Step 3: Type consistency checks

Run checks based on `SKILL_TYPE`.

**Feature skills:**
```bash
# Step 1 references branch merge
head -60 "$SKILL_DIR/SKILL.md" | grep -qi "merge\|fetch.*branch\|branch.*merge" && echo "PASS" || echo "FAIL (step 1 should merge the skill branch)"

# No source code files on main
NON_MD_COUNT=$(find "$SKILL_DIR" -type f ! -name "SKILL.md" ! -name "*.md" 2>/dev/null | wc -l)
[ "$NON_MD_COUNT" -eq 0 ] && echo "PASS" || echo "FAIL ($NON_MD_COUNT non-doc files on main — code should be on skill/* branch)"

# skill/* branch exists (informational)
git branch -r 2>/dev/null | grep -q "skill/.*$SKILL_NAME" && echo "PASS (branch found)" || echo "WARN (no skill/* branch — expected for new contributions, maintainer creates from PR)"
```

**Utility skills:**
```bash
# Code files present
CODE_FILES=$(find "$SKILL_DIR" -type f ! -name "SKILL.md" ! -name "*.md" 2>/dev/null)
[ -n "$CODE_FILES" ] && echo "PASS" || echo "FAIL (utility skill must have code files)"

# No branch merge instructions
head -60 "$SKILL_DIR/SKILL.md" | grep -qi "git merge\|git fetch.*skill/" && echo "FAIL (has branch merge — should be feature skill)" || echo "PASS"
```

**Operational skills:**
```bash
# No code files
NON_MD_COUNT=$(find "$SKILL_DIR" -type f ! -name "SKILL.md" ! -name "*.md" 2>/dev/null | wc -l)
[ "$NON_MD_COUNT" -eq 0 ] && echo "PASS" || echo "FAIL ($NON_MD_COUNT code files — should be utility skill)"

# No branch merge instructions
head -60 "$SKILL_DIR/SKILL.md" | grep -qi "git merge\|git fetch.*skill/" && echo "FAIL (has branch merge — should be feature skill)" || echo "PASS"
```

**Container skills:**
```bash
# Correct location
echo "$SKILL_DIR" | grep -q "^container/skills/" && echo "PASS" || echo "FAIL (not in container/skills/)"

# allowed-tools frontmatter (recommended)
head -15 "$SKILL_DIR/SKILL.md" | grep -q "allowed-tools" && echo "PASS" || echo "WARN (no allowed-tools — recommended for container skills)"
```

# Step 4: Code quality checks

Based on maintainer feedback patterns (ref: PR #1597). Skip N/A for operational skills.

**4a. No hardcoded paths** (utility: scan files; feature: scan diff; container: scan files):
```bash
# For utility and container skills — scan skill files:
grep -rn '/home/\|/Users/' "$SKILL_DIR" --include='*.sh' --include='*.ts' --include='*.js' --include='*.py' 2>/dev/null

# For feature skills — scan diff against main:
git diff main...HEAD -- '*.ts' '*.js' '*.sh' '*.py' 2>/dev/null | grep -E '^\+.*(/home/|/Users/)' | grep -v '^\+\+\+'
```

If matches found, show the lines and suggest using `$HOME` or relative paths.

**4b. Cross-platform compatibility** (utility and feature only):
```bash
# Check for Linux-only commands
grep -rn 'systemctl\|apt-get\|apt install\|dnf install' "$SKILL_DIR" --include='*.sh' --include='*.md' 2>/dev/null
```

If found, check for macOS equivalents (`launchctl`, `brew`) or a Linux-only note. If neither, WARN.

**4c. No `/dev/null` in scheduling contexts:**
```bash
grep -rn '/dev/null' "$SKILL_DIR" --include='*.sh' --include='*.md' 2>/dev/null
```

If found in cron/systemd/launchd context, FAIL. Suggest logging to a file instead.

**4d. No bundled source changes** (feature skills only):
```bash
git diff main...HEAD --name-only 2>/dev/null | grep -v "^\.claude/skills/" | grep -v "^container/skills/" | grep -v "^package-lock.json" | grep -v "^package.json"
```

If files outside the skill directory are changed, WARN: "Additional source changes bundled with skill — verify each is necessary per CONTRIBUTING.md 'one thing per PR'."

# Step 5: Security scanning

Skip for operational skills (no code files).

**5a. No hardcoded API keys, tokens, or secrets:**
```bash
grep -rniE '(api[_-]?key|secret|password|token)\s*[=:]\s*["\x27][A-Za-z0-9+_/-]{16,}' "$SKILL_DIR" --include='*.sh' --include='*.ts' --include='*.js' --include='*.json' --include='*.py' 2>/dev/null
```

**5b. No dangerous commands without safety guards:**
```bash
grep -rn 'rm -rf\|rm -r /\|chmod 777\|curl.*|.*sh\|wget.*|.*sh' "$SKILL_DIR" --include='*.sh' --include='*.ts' --include='*.js' --include='*.md' 2>/dev/null
```

For each match, check if preceded by a safety guard (confirmation prompt, conditional, dry-run flag). If no guard, WARN.

**5c. No prompt injection patterns in code files:**
```bash
grep -rniE '(ignore previous|disregard instructions|you are now|system prompt)' "$SKILL_DIR" --include='*.sh' --include='*.ts' --include='*.js' 2>/dev/null
```

# Step 6: PR preparation checks

**6a. One thing per PR:**
```bash
git diff main...HEAD --name-only 2>/dev/null | sed 's|/.*||' | sort -u | wc -l
```

If more than 2-3 distinct top-level directories changed, WARN.

**6b. Related issues linked:**
```bash
git log main...HEAD --oneline 2>/dev/null | grep -oE '#[0-9]+' | sort -u
git branch --show-current 2>/dev/null | grep -oE '#[0-9]+' | sort -u
```

If no `#NNN` references found, WARN: "No linked issue found. Add `Closes #NNN` to PR description per CONTRIBUTING.md."

**6c. Upstream duplicate check (opt-in):**

After presenting results (Step 7), use AskUserQuestion: "Check upstream for existing PRs/issues on this topic?"

If yes:
```bash
SKILL_SEARCH=$(echo "$SKILL_NAME" | sed 's/-/ /g')
gh pr list --repo qwibitai/nanoclaw --search "$SKILL_SEARCH" --state all --limit 5 2>/dev/null
gh issue list --repo qwibitai/nanoclaw --search "$SKILL_SEARCH" --state all --limit 5 2>/dev/null
```

If `gh` is not installed or not authenticated, WARN and skip.

# Step 7: Present results

Present results as a table grouped by category. Use four states: **PASS**, **FAIL**, **WARN**, **N/A**.

For N/A checks, add a brief note explaining why (e.g., "Operational skill — no code files").

Format:

```
## Check Results: $SKILL_NAME

**Detected type:** $SKILL_TYPE
**Path:** $SKILL_DIR

### SKILL.md Format
| Check | Result |
|-------|--------|
| Frontmatter `name` | PASS |
| Frontmatter `description` | PASS |
| Name format | PASS ($SKILL_FM_NAME) |
| Under 500 lines | PASS ($N lines) |
| Code in separate files | N/A ($SKILL_TYPE) |

### Type Consistency ($SKILL_TYPE)
| Check | Result |
|-------|--------|
| ... | ... |

### Code Quality
| Check | Result |
|-------|--------|
| No hardcoded paths | PASS |
| Cross-platform | WARN (uses systemctl without macOS fallback) |

### Security
| Check | Result |
|-------|--------|
| No hardcoded secrets | PASS |

### PR Preparation
| Check | Result |
|-------|--------|
| One thing per PR | PASS |
| Issue linked | FAIL (no #NNN found) |

---

**Passed:** N | **Warnings:** N | **Failed:** N

**Fix needed:**
- [ ] Link related issue: add `Closes #NNN` to PR description
- [ ] Add macOS fallback for `systemctl` usage
```

Each FAIL/WARN should have a one-line fix suggestion in the action items list. Only list items that need action — skip PASS and N/A.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Not in a git repository" | Run from within the NanoClaw repo directory |
| `gh` commands fail | Install GitHub CLI and run `gh auth login` |
| Ambiguous skill type | The skill has characteristics of multiple types — restructure to fit one type clearly |
| Feature skill shows no branch | Normal for new contributions — maintainer creates `skill/*` branch from PR |
| Checks run on wrong files | Ensure you're on the correct branch with only your skill changes |
