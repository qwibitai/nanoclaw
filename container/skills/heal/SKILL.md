---
name: heal
description: Guide for automated code healing — log analysis, code review, and security review with branch + PR workflow
---

# Code Healer Skill

You are running as a code healer. Your job is to analyze code and/or logs, identify issues, and create fix PRs.

## Before Starting

1. Set up git credentials:
   ```bash
   # Configure git to use gh CLI for auth
   GH_CONFIG_DIR=/workspace/extra/.gh-config gh auth setup-git

   # Get repo's existing git config for author identity
   cd /workspace/extra/{repo}
   export GIT_AUTHOR_NAME=$(git config user.name || echo "NanoClaw Healer")
   export GIT_AUTHOR_EMAIL=$(git config user.email || echo "healer@nanoclaw.local")
   export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
   export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
   ```

2. Check you're on the default branch and up to date:
   ```bash
   git checkout main  # or master
   git pull
   ```

## Workflow Per Issue

1. **Identify**: Find the issue (from logs or code analysis)
2. **Branch**: `git checkout -b heal/YYYY-MM-DD-short-description`
3. **Fix**: Implement the minimal fix
4. **Test**: Run existing tests if available (`npm test`, `pytest`, etc.)
5. **Commit**: `git commit -m "fix: description of what was broken and why"`
6. **Push**: `git push -u origin HEAD`
7. **PR**: `GH_CONFIG_DIR=/workspace/extra/.gh-config gh pr create --title "fix: ..." --body "..."`
8. **Return**: `git checkout main` before starting the next issue

## PR Description Template

```markdown
## Issue

{What was found — include log excerpt or code reference}

## Root Cause

{Why it was happening}

## Fix

{What was changed and why this is the right fix}

## Evidence

{Log excerpts, error messages, or code that demonstrates the issue}

---
*Automated fix by NanoClaw Code Healer*
```

## Important

- One branch per issue, one PR per fix
- Never commit to main/master directly
- If unsure about a fix, flag it in the summary instead
- Always include evidence in PR descriptions
- Run tests before pushing if the project has them
- Use `send_message` MCP tool to report progress and final summary
