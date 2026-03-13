---
name: add-x-reader
description: Add X (Twitter) reading capabilities — search tweets by topic and get posts from specific accounts via the X API. Triggers on "add x reader", "x reader", "read tweets", "search x", "x search".
---

# Add X Reader

Add the ability to search tweets by topic and retrieve posts from specific X (Twitter) accounts using the X API v2.

## Prerequisites

- Existing NanoClaw installation
- X Developer account with API access (Basic plan or pay-per-use)
- X API Bearer Token

## What This Adds

Two new MCP tools available to the agent:

| Tool | Purpose |
|------|---------|
| `x_search` | Search recent tweets (last 7 days) by keyword/topic |
| `x_user_posts` | Get recent tweets from a specific @username |

Results are returned as formatted text. The agent can save them to files for future reference.

## Setup Steps

### 1. Get X API Bearer Token

1. Go to https://developer.x.com/en/portal/dashboard
2. Create a project and app (or use existing)
3. Generate a Bearer Token (App-only access)
4. Copy the token

### 2. Add Bearer Token to `.env`

```bash
echo 'X_BEARER_TOKEN=your_bearer_token_here' >> .env
```

### 3. Apply Code Changes

The following files need to be modified. Apply each change:

#### 3a. Add API scripts

Create these files (they already exist in this skill directory):

- Copy `scripts/lib/api.ts` to `.claude/skills/add-x-reader/scripts/lib/api.ts`
- Copy `scripts/search-tweets.ts` to `.claude/skills/add-x-reader/scripts/search-tweets.ts`
- Copy `scripts/user-timeline.ts` to `.claude/skills/add-x-reader/scripts/user-timeline.ts`

#### 3b. Modify `src/x-handler.ts`

Add two new cases to the switch statement in `handleXIpc()`:

```typescript
case 'x_search':
  if (!data.query) {
    result = { success: false, message: 'Missing query' };
    break;
  }
  result = await runXApiScript('search-tweets', {
    query: data.query,
    maxResults: data.maxResults || 10,
  });
  break;

case 'x_user_timeline':
  if (!data.username) {
    result = { success: false, message: 'Missing username' };
    break;
  }
  result = await runXApiScript('user-timeline', {
    username: data.username,
    maxResults: data.maxResults || 10,
  });
  break;
```

Also add the `runXApiScript()` helper that reads `X_BEARER_TOKEN` from `.env` and passes it to the script.

#### 3c. Modify `container/agent-runner/src/ipc-mcp-stdio.ts`

Add two new MCP tool definitions after the existing X tools:

- `x_search` — takes `query` (string) and optional `max_results` (number, default 10, max 100)
- `x_user_posts` — takes `username` (string) and optional `max_results` (number, default 10, max 100)

Both use the same IPC pattern: write to tasks dir, poll for result via `waitForXResult()`.

#### 3d. Update `groups/main/CLAUDE.md`

Add the new tools to the X Integration section:

```
- `mcp__nanoclaw__x_search` — Search recent tweets. Parameters: `query` (string), `max_results` (number, optional)
- `mcp__nanoclaw__x_user_posts` — Get posts from a user. Parameters: `username` (string), `max_results` (number, optional)
```

#### 3e. Update `.env.example`

Add:
```
X_BEARER_TOKEN=
```

### 4. Rebuild Container

```bash
./container/build.sh
```

### 5. Verify

Restart NanoClaw and test:
```
@Andy search X for recent posts about "AI safety"
@Andy get the latest posts from @elaborateclaw
```

## API Limits

- **Search:** 450 requests per 15 minutes (app-only auth)
- **User timeline:** 1,500 requests per 15 minutes
- **Search range:** Last 7 days only (Basic/pay-per-use tier)
- **Results per request:** Max 100

## Troubleshooting

| Issue | Fix |
|-------|-----|
| 401 Unauthorized | Check X_BEARER_TOKEN in .env |
| 403 Forbidden | Your API plan may not include this endpoint |
| 429 Rate Limited | Wait 15 minutes, reduce request frequency |
| Empty results | Try broader search terms, check spelling |
