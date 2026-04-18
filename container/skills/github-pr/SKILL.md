---
name: github-pr
description: Fix a GitHub issue and create a PR. Clone, branch, fix, test, PR.
trigger: fix issue|create pr|github issue|fix bug|open pr|pull request
---

# Fix GitHub Issue & Create PR

You can fix GitHub issues and create pull requests. Follow this workflow exactly.

## Workflow

### 1. Understand the issue
```bash
gh issue view <number> --repo <owner/repo> --json title,body,labels,comments
```
Read the issue thoroughly. Understand the expected behavior, reproduction steps, and any discussion.

### 2. Clone into a fresh workspace
NEVER modify files under `/workspace/extra/` — those are the user's working trees mounted read-only.

```bash
cd /tmp
gh repo clone <owner/repo> -- --depth=50
cd <repo>
```

### 3. Create a branch
```bash
git checkout -b fix/<issue-number>-<short-description>
```

### 4. Investigate the codebase
- Read relevant files to understand the code structure
- Find the root cause before making changes
- Check existing tests for patterns to follow

### 5. Make the fix
- Make minimal, focused changes that address the issue
- Follow the repo's existing code style and conventions
- Do not add unrelated changes

### 6. Run tests
```bash
# Detect and run the project's test suite
# Check package.json, Makefile, or CI config for the test command
npm test  # or pytest, cargo test, go test, etc.
```
If tests fail, fix them before proceeding.

### 7. Commit
```bash
git add -A
git commit -m "Fix #<issue-number>: <concise description>

<explanation of what was wrong and how this fixes it>"
```

### 8. Push and create PR
```bash
git push -u origin HEAD
gh pr create \
  --title "Fix #<issue-number>: <concise description>" \
  --body "Fixes #<issue-number>

## What
<brief description of the change>

## Why
<root cause explanation>

## How
<what you changed and why>

## Testing
<how you verified the fix>" \
  --repo <owner/repo>
```

### 9. Report back
Tell the user:
- The PR URL
- What you found (root cause)
- What you changed
- Whether tests passed

## Rules
- ALWAYS clone fresh into /tmp — never modify mounted directories
- ALWAYS run tests before creating the PR
- ALWAYS reference the issue number in the PR
- If you can't figure out the fix, say so — don't create a bad PR
- If the repo has no tests, note that in the PR description
- Keep changes minimal and focused
