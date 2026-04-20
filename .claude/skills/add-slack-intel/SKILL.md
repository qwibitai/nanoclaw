---
name: add-slack-intel
description: Give Almanda read access to Slack — channel history, thread replies, user directory, and message search. Reuses the existing SLACK_BOT_TOKEN. Requires additional OAuth scopes if not already granted.
---

# Add Slack Intel

Adds read-side Slack access so Almanda can search conversations, look up teammates, and provide channel context.

## Prerequisites
- `/add-almanda-core` installed
- Slack channel already set up (`/add-slack` complete — `SLACK_BOT_TOKEN` in .env)
- Bot token needs these OAuth scopes (verify in Slack app settings):
  - `channels:history`, `channels:read`
  - `groups:read`, `groups:history`
  - `im:read`, `mpim:read`
  - `users:read`, `users:read.email`
  - `search:read`

## Installation

### 1. Merge the skill branch
```bash
git merge feature/v2-mcp-bundle --no-edit
```

### 2. Confirm SLACK_BOT_TOKEN is in .env
```bash
grep "SLACK_BOT_TOKEN" .env
```
No change needed if the Slack channel is already configured.

### 3. Add missing OAuth scopes (if needed)
Go to https://api.slack.com/apps → your app → OAuth & Permissions → Bot Token Scopes.
Add any missing scopes from the list above and reinstall the app.

### 4. Rebuild and restart
```bash
./container/build.sh && npm run build
rm -rf data/sessions/*/agent-runner-src/
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

### 5. Verify
Ask: "List our Slack channels"
Expected: returns channel list, no approval prompt.

Ask: "Post to #general: hello"
Expected: Almanda asks approval before posting.

## Notes
- Uses `slack-mcp-server` via `npx` — downloaded on first container run
- Message posting is disabled by default in the MCP config (`SLACK_MCP_ADD_MESSAGE_TOOL=false`) — posting goes through the Slack channel integration instead
