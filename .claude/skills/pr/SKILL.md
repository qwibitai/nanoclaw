---
name: pr
description: Create a pull request for the current changes. If on main, creates a feature branch and commits first. Handles secret scanning, co-author credits, and PR creation via gh CLI. Use when user says "create pr", "open pr", "pull request", or "pr".
---

# Create Pull Request

## 1. Determine Branch State

```bash
git branch --show-current
```

### If on `main`: Branch and Commit First

When the current branch is `main`, changes need to go on a feature branch before creating a PR.

1. **Generate a branch name** from the changes — short, kebab-case, descriptive (e.g. `add-pr-skill`, `fix-auth-timeout`).

2. **Create and switch to the branch:**

```bash
git checkout -b <branch-name>
```

3. **Run the `/commit` skill** to stage, scan for secrets, and commit the changes on the new branch. Follow all its steps (secret scan, .gitignore check, specific file staging, co-author credits).

### If on a feature branch: Continue

Changes are already on the right branch. If there are uncommitted changes, run the `/commit` skill first. If everything is already committed, proceed to step 2.

## 2. Push the Branch

```bash
git push -u origin <branch-name>
```

Never force push without explicit user confirmation.

## 3. Create the Pull Request

Use `gh` CLI to create the PR against `main`.

First, review what will be in the PR:

```bash
git log --oneline main..HEAD
git diff --stat main..HEAD
```

Then create the PR:

```bash
gh pr create --base main --title "<short title>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points describing what changed and why>

## Test plan
<bulleted checklist of how to verify the changes>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### PR Title Guidelines

- Keep under 70 characters
- Use imperative mood (e.g. "Add PR creation skill", not "Added PR creation skill")
- Match the commit message style: `type: description` (e.g. `feat: add /pr skill`)

### PR Body Guidelines

- Summary should explain the **why**, not just the **what**
- Test plan should be actionable steps someone can follow
- If there are multiple commits, summarize the overall change, not each commit

## 4. Report Back

Show the user:
- The PR URL
- The branch name
- A brief summary of what's in the PR
