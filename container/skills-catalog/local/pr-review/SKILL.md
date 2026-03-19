---
name: pr-review
description: Review GitHub PRs using structured code review methodology. Trigger when asked to review a PR or given a PR URL to review.
---

# PR Review

When asked to review a PR, follow this workflow:

## 1. Get the PR

```bash
# Clone if needed
gh repo clone {owner}/{repo} /workspace/group/repos/{owner}/{repo} 2>/dev/null || true
cd /workspace/group/repos/{owner}/{repo}

# Fetch and checkout the PR
gh pr checkout {number}

# Get the diff
gh pr diff {number} > /tmp/pr-diff.txt
```

## 2. Review the Code

Use the `requesting-code-review` skill methodology. Review the diff for:

**Code Quality:** Clean separation of concerns, proper error handling, type safety, DRY, edge cases
**Architecture:** Sound design decisions, scalability, performance, security
**Testing:** Tests actually test logic, edge cases covered, integration tests where needed
**Requirements:** Does the PR accomplish what it claims?

For large diffs (>5000 lines), review file-by-file rather than the full diff at once.

## 3. Post the Review

Map your findings to a GitHub review action:

- **Critical or Important issues found** -> request changes:
  ```bash
  gh pr review {number} --request-changes --body "review summary here"
  ```

- **Only Minor issues** -> comment:
  ```bash
  gh pr review {number} --comment --body "review summary here"
  ```

- **No issues (clean)** -> approve:
  ```bash
  gh pr review {number} --approve --body "review summary here"
  ```

### Inline Comments

For file-specific feedback, post inline comments:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -f body="suggestion here" \
  -f path="src/file.ts" \
  -F line=42 \
  -f commit_id="$(gh pr view {number} --json headRefOid -q .headRefOid)"
```

## 4. Auth Scope

If you get a 403 or permission error when posting a review, the `GH_TOKEN` likely doesn't have access to that repo. In that case:
- Notify the user via `send_message` with the review summary instead
- Explain that you couldn't post directly due to permissions

## 5. Optional: Watch the PR

After reviewing, offer to watch the PR for follow-up changes:

```bash
echo '{"type": "watch_pr", "repo": "{owner}/{repo}", "pr_number": {number}, "source": "manual"}' > /workspace/ipc/prs/watch_$(date +%s).json
```
