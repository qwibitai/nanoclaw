---
name: add-slack-ops
description: Connect Slack write access to Almanda — post messages to channels and DMs, add reactions. Reuses SLACK_BOT_TOKEN from add-slack-intel. All writes require user approval. Use after add-slack-intel is installed.
---

# Add Slack Operations

Enables Almanda to post messages, DM teammates, and react in the Alma Labs Slack workspace.

## Prerequisites

- `/add-almanda-core` installed (operating rules enforce write approval)
- `/add-slack-intel` installed (Slack bot token wired; this skill extends it with write access)

## Installation

### 1. Add new OAuth scopes to the Slack app

At [api.slack.com/apps](https://api.slack.com/apps) → Almanda app → **OAuth & Permissions** → Bot Token Scopes, add:

- `chat:write.public` — post to any public channel without needing to be invited
- `im:write` — DM any user
- `mpim:write` — group DMs
- `reactions:write` — add and remove emoji reactions
- `groups:write` — post to private channels the bot is invited to

Then click **Reinstall to Workspace** to apply the new scopes.

> **Token rotation:** Slack may issue a new `xoxb-` token on reinstall. If so, update `SLACK_BOT_TOKEN` in `.env` before the next step.

### 2. Rebuild and restart

```bash
./container/build.sh && npm run build
rm -rf data/sessions/*/agent-runner-src/
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# systemctl --user restart nanoclaw               # Linux
```

### 3. Verify

Ask Almanda from any registered channel:

```
"What Slack tools do you have?"
```
Expected: lists both read tools (channels, history, search) and write tools (conversations_add_message, reactions_add).

```
"DM me on Slack: hello from Almanda"
```
Expected: Almanda describes the DM and asks "Should I go ahead?", then sends it.

```
"Post to #proj-almanda: smoke test"
```
Expected: approval prompt, then message appears in the channel.

## Notes

- Uses `slack-mcp-server` (korotovsky) via `npx`. This skill flips `SLACK_MCP_ADD_MESSAGE_TOOL=true` on the existing `slack-intel` MCP server — no second MCP process.
- The bot must be `/invite`d to private channels before posting. `chat:write.public` covers public channels without an invite.
- The host-side outbound path (`src/channels/slack.ts`) is unchanged and continues to handle replies in registered groups.
- Container playbook: `/slack-ops` in Almanda's skill library.
