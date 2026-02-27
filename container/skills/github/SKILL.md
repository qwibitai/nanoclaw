---
name: github
description: Interact with GitHub — create issues, comment on PRs, manage repos, and more. Use the GitHub REST API with curl and the GITHUB_TOKEN environment variable.
allowed-tools: Bash(github:*)
---

# GitHub API

Your environment has a `GITHUB_TOKEN` env var for authenticated GitHub API access.

## Quick reference

```bash
# Create an issue
curl -s -X POST "https://api.github.com/repos/OWNER/REPO/issues" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"title": "Bug report", "body": "Description here", "labels": ["bug"]}'

# Comment on an issue or PR
curl -s -X POST "https://api.github.com/repos/OWNER/REPO/issues/NUMBER/comments" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"body": "Comment text"}'

# List issues
curl -s "https://api.github.com/repos/OWNER/REPO/issues?state=open" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json"

# Get a single issue or PR
curl -s "https://api.github.com/repos/OWNER/REPO/issues/NUMBER" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json"

# List repos for authenticated user
curl -s "https://api.github.com/user/repos?per_page=10&sort=updated" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json"

# Search issues
curl -s "https://api.github.com/search/issues?q=repo:OWNER/REPO+is:open+label:bug" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json"

# Close an issue
curl -s -X PATCH "https://api.github.com/repos/OWNER/REPO/issues/NUMBER" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"state": "closed"}'
```

## Tips

- Always use `$GITHUB_TOKEN` from the environment — never ask the user for a token.
- Use `jq` to parse JSON responses: `curl ... | jq '.html_url'`
- The API base is `https://api.github.com`.
- For PR-specific endpoints (merge, reviews, files), use `/repos/OWNER/REPO/pulls/NUMBER`.
- Rate limit: 5000 requests/hour for authenticated requests.
