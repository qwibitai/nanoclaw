---
name: agent-github
description: Manage GitHub issues, pull requests, and code review. Use for any GitHub task — listing issues, reviewing PRs, checking CI status, adding labels, posting comments, and implementing code changes end-to-end (clone → branch → commit → push → PR).
allowed-tools: Bash(gh:*), Bash(git:*)
---

# GitHub CLI (`gh`) and Git

## Authentication

`gh` is pre-authenticated via `GITHUB_TOKEN` env var. The target repo is set via `GH_REPO` (e.g., `owner/repo`), so you don't need to specify `--repo` on every command.

## Read operations

### Issues

```bash
gh issue list                              # Open issues
gh issue list --state closed --limit 10    # Recent closed issues
gh issue list --label "bug"                # Filter by label
gh issue list --assignee "@me"             # Assigned to me
gh issue list --search "keyword"           # Search issues
gh issue view 42                           # View issue details
gh issue view 42 --comments                # Include comments
```

### Pull requests

```bash
gh pr list                                 # Open PRs
gh pr list --state merged --limit 10       # Recent merged PRs
gh pr list --author "username"             # Filter by author
gh pr view 99                              # View PR details
gh pr view 99 --comments                   # Include comments
gh pr diff 99                              # View PR diff
gh pr checks 99                            # CI/check status
```

### Repository info

```bash
gh api repos/{owner}/{repo}/branches       # List branches
gh api repos/{owner}/{repo}/commits?per_page=10  # Recent commits
gh api repos/{owner}/{repo}/releases/latest # Latest release
gh api repos/{owner}/{repo}/actions/runs?per_page=5  # Recent workflow runs
```

## Safe write operations

### Issue comments and labels

```bash
gh issue comment 42 --body "Looks good, marking as reviewed."
gh issue edit 42 --add-label "reviewed"
gh issue edit 42 --remove-label "needs-triage"
gh issue edit 42 --add-assignee "username"
```

### PR comments and reviews

```bash
gh pr comment 99 --body "LGTM, one minor suggestion below."
gh pr review 99 --approve --body "Approved."
gh pr review 99 --request-changes --body "Please fix the failing test."
gh pr review 99 --comment --body "Looks good overall."
```

## Quest workflow (clone → branch → implement → PR)

When assigned a GitHub issue or asked to implement a code change, follow this workflow:

### 1. Clone the repository

```bash
REPO_DIR="/workspace/group/repos/$(echo $GH_REPO | tr '/' '-')"
git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${GH_REPO}.git" "$REPO_DIR"
cd "$REPO_DIR"
```

If the directory already exists, update it instead:

```bash
cd "$REPO_DIR" && git fetch origin && git checkout main && git pull
```

### 2. Create a branch

Use a descriptive name based on the issue type and number:

```bash
git checkout -b fix/42-short-description      # for bug fixes
git checkout -b feat/42-short-description     # for features
git checkout -b chore/42-short-description    # for maintenance
```

### 3. Implement the changes

Read the issue carefully. Make the minimal changes needed. Prefer editing existing files over creating new ones.

### 4. Commit

```bash
git add -A
git commit -m "fix: short description (closes #42)"
```

Commit message conventions:
- `fix:` for bug fixes
- `feat:` for new features
- `chore:` for maintenance
- Always include `(closes #N)` or `(fixes #N)` to auto-close the issue on merge

### 5. Push

```bash
git push origin HEAD
```

### 6. Create a pull request

```bash
gh pr create \
  --title "fix: short description" \
  --body "$(cat <<'EOF'
## Summary

Brief description of what was changed and why.

Closes #42

## Changes

- List key changes here

## Test plan

- [ ] Describe how to verify the fix
EOF
)" \
  --base main
```

### 7. Report back

After creating the PR, use the `send_message` MCP tool to comment back on the original issue with the PR URL so the requester knows it's done.

## NOT allowed

Do NOT perform these operations — they are destructive or require human decision:

- `gh pr merge` / `gh pr close` / `gh pr reopen`
- `gh issue close` / `gh issue reopen` (without explicit instruction)
- `gh release create` / `gh release delete`
- `gh repo delete` / `gh repo rename`
- `git push --force` / `git push --force-with-lease`
- Any `gh api -X DELETE` call
- Any `gh api -X PUT/PATCH` on branch protection rules

## Tips

- Use `--json` for structured output: `gh issue list --json number,title,labels`
- Combine with `jq` for filtering: `gh pr list --json number,title,checks --jq '.[] | select(.checks | length > 0)'`
- Rate limits: GitHub allows 5,000 requests/hour with token auth
- For large lists, use `--limit`: `gh issue list --limit 50`
- HTTPS clone with token avoids SSH key requirements in the container
