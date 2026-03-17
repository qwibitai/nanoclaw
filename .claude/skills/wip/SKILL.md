---
name: wip
description: Search for in-progress work — worktrees, open PRs, dirty branches, active cases. Triggers on "wip", "in progress", "what's open", "existing work".
---

# /wip — Find In-Progress Work

Search all sources of in-progress work and present a summary to the user.

## Procedure

Run ALL of the following checks in parallel:

### 1. Git Worktrees
```bash
git worktree list
```
For each worktree (excluding the main checkout), check:
```bash
git -C <worktree_path> log --oneline -3
git -C <worktree_path> status --short
git -C <worktree_path> log --oneline @{upstream}..HEAD 2>/dev/null  # unpushed commits
```

### 2. Open Pull Requests
```bash
gh pr list --repo Garsson-io/nanoclaw --state open --json number,title,headBranch,state,updatedAt,url
```

### 3. Local Branches with Unpushed Work
```bash
git branch --no-merged main
```

### 4. Stale Local Branches (merged but not deleted)
```bash
git branch --merged main | grep -v '^\*\|main$'
```

### 5. Active Cases with Kaizen Issue Links
Check the cases SQLite database for active/backlog cases linked to GitHub issues:
```bash
sqlite3 data/nanoclaw.db "SELECT name, status, github_issue FROM cases WHERE github_issue IS NOT NULL AND status IN ('suggested','backlog','active','blocked') ORDER BY github_issue"
```

## Output Format

Present a concise summary table:

```
## In-Progress Work

### Worktrees (N)
| Worktree | Branch | Status | Unpushed |
|----------|--------|--------|----------|
| ...      | ...    | clean/dirty (N files) | N commits |

### Open PRs (N)
| # | Title | Branch | Updated |
|---|-------|--------|---------|
| ...

### Unmerged Branches (N)
- branch-name (N ahead of main)

### Cleanup Candidates
- branch-name (already merged, can delete)

### Kaizen Issues with Active Cases
| Kaizen # | Case | Status |
|----------|------|--------|
| #N       | YYMMDD-HHMM-case-name | active/backlog/blocked |
```

If any section has zero items, still show it with "None" to confirm it was checked.

## Recommendations

After presenting the summary, suggest actions:
- For dirty worktrees: "Consider committing or stashing changes in X"
- For stale branches: "These are merged and can be cleaned up with `git branch -d <name>`"
- For orphaned worktrees (no corresponding PR): flag them
- For open PRs: note if the local branch is behind remote
