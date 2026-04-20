---
name: github-ops
description: GitHub repositories, issues, pull requests, code search, branches, and file content — read freely, comment/open PR/merge/push only with user approval. Tools: mcp__github__search_code, search_issues_prs, read_file, list_files, create_pull_request, update_pull_request, create_issue.
---

# GitHub Operations

Access Alma Labs' GitHub organization for code and project tasks.

## Read freely (no approval needed)

| Action | Tool |
|---|---|
| Search code | `mcp__github__search_code` |
| Find issues / PRs | `mcp__github__search_issues_prs` |
| Read a file | `mcp__github__read_file` |
| List files | `mcp__github__list_files` |
| Search users | `mcp__github__search_users` |

## Write actions (load /almanda-ops, ask approval first)

| Action | Tool | Approval phrasing |
|---|---|---|
| Comment on issue/PR | Bash `gh issue comment` / `gh pr comment` | "I'll comment on [#N]: '[text]'. Should I go ahead?" |
| Create PR | `mcp__github__create_pull_request` | "I'll open a PR from [branch] → [base]: '[title]'. Should I go ahead?" |
| Merge PR | Bash `gh pr merge` | "I'll merge PR #[N] ([title]). Should I go ahead?" |
| Create issue | `mcp__github__create_issue` | "I'll open issue '[title]' in [repo]. Should I go ahead?" |
| Push / update file | `mcp__github__update_file` | "I'll update [file] in [repo]: [summary of change]. Should I go ahead?" |

## Hard limits (never do without explicit instruction)

- Never force-push to `main` or `master`
- Never merge a PR without at least one reviewer or explicit user override
- Never delete a branch with open PRs

## Examples

> "Find all files that import auth middleware" → `search_code` with query
> "What open PRs need review?" → `search_issues_prs` type=pr state=open review=needed
> "Open a PR for my branch" → ask approval, then `create_pull_request`
> "Read the README in almalabs/backend" → `read_file` path=README.md
