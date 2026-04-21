---
name: agent-github
description: Manage GitHub issues, pull requests, and code review for the repository. Use for any GitHub task — listing issues, reviewing PRs, checking CI status, adding labels, posting comments.
allowed-tools: Bash(gh:*)
---

# GitHub CLI (`gh`)

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

## NOT allowed

Do NOT perform these operations — they are destructive or require human decision:

- `gh pr merge` / `gh pr close` / `gh pr reopen`
- `gh issue create` / `gh issue close` / `gh issue reopen`
- `gh release create` / `gh release delete`
- `gh repo delete` / `gh repo rename`
- `git push --force` / `git push --force-with-lease`
- Any `gh api -X DELETE` call
- Any `gh api -X PUT/PATCH` on branch protection rules

## Tips

- Use `--json` for structured output: `gh issue list --json number,title,labels`
- Combine with `jq` for filtering: `gh pr list --json number,title,checks --jq '.[] | select(.checks | length > 0)'`
- Rate limits: GitHub allows 5,000 requests/hour with token auth — plenty for normal use
- For large lists, use `--limit`: `gh issue list --limit 50`
- To get the repo owner/name: `gh repo view --json nameWithOwner --jq .nameWithOwner`
