---
name: github-digest
description: Generates a daily engineering activity digest across sagri-tokyo GitHub repositories, summarizing PRs merged, issues opened/closed, CI failures, and notable changes.
---

## Purpose

Produce a structured engineering digest for the sagri-tokyo GitHub organisation. The default time window is the last 24 hours. The caller may pass an explicit `--hours N` parameter to override the window.

## Repositories to scan

- `sagri-tokyo/mrv`
- `sagri-tokyo/farmland-utilization`
- `sagri-tokyo/dohyo`
- `sagri-tokyo/ml-rqs`
- `sagri-tokyo/sagri-ai`
- `sagri-tokyo/infrastructure`
- `sagri-tokyo/ml-commons`

## Step-by-step instructions

### 1. Compute the time window

```bash
HOURS="${HOURS:-24}"
SINCE=$(date -u -d "${HOURS} hours ago" '+%Y-%m-%dT%H:%M:%SZ')
[ -n "$SINCE" ] || { echo "ERROR: could not compute time window" >&2; exit 1; }
TODAY=$(date -u '+%Y-%m-%d')
```

### 2. Fetch PRs merged

For each repo, retrieve merged pull requests within the time window:

```bash
gh pr list \
  --repo "sagri-tokyo/$REPO" \
  --state merged \
  --limit 100 \
  --json number,title,author,mergedAt,url \
  | jq --arg since "$SINCE" '[.[] | select(.mergedAt >= $since) | {number, title, author: .author.login, mergedAt, url}]'
```

### 3. Fetch PRs opened

```bash
gh pr list \
  --repo "sagri-tokyo/$REPO" \
  --state open \
  --limit 100 \
  --json number,title,author,createdAt,url \
  | jq --arg since "$SINCE" '[.[] | select(.createdAt >= $since) | {number, title, author: .author.login, createdAt, url}]'
```

### 4. Fetch issues opened

```bash
gh issue list \
  --repo "sagri-tokyo/$REPO" \
  --state open \
  --limit 100 \
  --json number,title,labels,createdAt,url \
  | jq --arg since "$SINCE" '[.[] | select(.createdAt >= $since) | {number, title, labels: [.labels[].name], createdAt, url}]'
```

### 5. Fetch issues closed

```bash
gh issue list \
  --repo "sagri-tokyo/$REPO" \
  --state closed \
  --limit 100 \
  --json number,title,closedAt,url \
  | jq --arg since "$SINCE" '[.[] | select(.closedAt != null and .closedAt >= $since) | {number, title, closedAt, url}]'
```

### 6. Fetch failed CI runs

```bash
gh run list \
  --repo "sagri-tokyo/$REPO" \
  --status failure \
  --limit 20 \
  --json databaseId,workflowName,headBranch,updatedAt,url \
  | jq --arg since "$SINCE" '[.[] | select(.updatedAt >= $since) | {workflowName, headBranch, updatedAt, url}]'
```

### 7. Aggregate across all repositories

Combine results from all repos per category. Deduplicate PRs and issues by `(repo, number)`. Deduplicate CI failures by `(repo, workflowName, headBranch)`, keeping the most recent run.

### 8. Format the Markdown report

Produce a structured Markdown document with this layout:

```
# Engineering Digest — <TODAY> (last <HOURS> hours)

## PRs Merged
| Repo | # | Title | Author |
|------|---|-------|--------|
| mrv  | 42 | Fix soil index calculation | @alice |

_(None)_ if empty.

## PRs Opened
| Repo | # | Title | Author |
|------|---|-------|--------|

_(None)_ if empty.

## Issues Opened
| Repo | # | Title | Labels |
|------|---|-------|--------|

_(None)_ if empty.

## Issues Closed
| Repo | # | Title |
|------|---|-------|

_(None)_ if empty.

## CI Failures
| Repo | Workflow | Branch | Link |
|------|----------|--------|------|

_(None)_ if empty.
```

Truncate any title beyond 80 characters with `…`.

### 9. Deliver the report

- If the caller requests Slack delivery, post the Markdown text to `#engineering` via the `SLACK_WEBHOOK_URL` environment variable:

  ```bash
  curl -s -X POST "$SLACK_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg text "$DIGEST" '{"text": $text}')"
  ```

- If the caller requests Notion delivery, create or update a Notion page via the Notion API using `NOTION_TOKEN`.
- Otherwise, return the formatted Markdown to the caller.

## Error handling

- If a repo returns a 403 error, abort and report an authentication failure. Do not produce a partial digest.
- If a repo returns 404, include a visible warning at the top of the report that the repo was skipped, then continue with the remaining repos.
- Never fabricate data. If a fetch fails, mark that section as unavailable rather than omitting it silently.
