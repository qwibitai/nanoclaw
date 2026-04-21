---
name: slack-ops
description: Slack write actions — post messages to channels or DMs, add/remove reactions. Tools: mcp__slack-intel__conversations_add_message, mcp__slack-intel__reactions_add, mcp__slack-intel__reactions_remove. Reads use the /slack-intel playbook; this playbook covers writes only.
---

# Slack Operations

Write access to the Alma Labs Slack workspace. All write actions require user approval.

## Write actions (ask approval first)

Use the approval template from `/almanda-ops`: describe what you're about to do, then ask "Should I go ahead?" on one line.

| Action | Tool | Approval phrasing |
|---|---|---|
| Post to channel | `mcp__slack-intel__conversations_add_message` | "I'll post to #{channel}: '{preview}'. Should I go ahead?" |
| DM a teammate | `mcp__slack-intel__conversations_add_message` (use D… channel id or @username_dm) | "I'll DM {person}: '{preview}'. Should I go ahead?" |
| React to message | `mcp__slack-intel__reactions_add` | "I'll react :{emoji}: to that message. Should I go ahead?" |
| Remove reaction | `mcp__slack-intel__reactions_remove` | "I'll remove the :{emoji}: reaction. Should I go ahead?" |

## Hard limits

- Never post to `#announcements` or `#general` unless the user explicitly names that channel.
- Don't DM anyone not in `people.json` (the identity map) unless the user provides a specific Slack user ID.
- Don't post the same message to multiple channels in one action — always confirm the target first.

## Tool notes

- `conversations_add_message` accepts a `channel` parameter (channel ID like `C…`, DM channel ID like `D…`, or `@username` for DM lookup).
- `reactions_add` / `reactions_remove` require `channel`, `timestamp` (the message `ts`), and `name` (emoji name without colons).
- The bot must be invited to private channels before it can post. `chat:write.public` lets it post to public channels without an invite.
- If these tool names drift across `slack-mcp-server` versions, run `list_tools` to see the current names and adapt.

## Examples

> "Post to #proj-almanda: standup is at 10am" → ask approval, then `conversations_add_message` with channel=#proj-almanda
> "DM Andrey: your PR is ready for review" → ask approval, then `conversations_add_message` with channel=D0ATK0J6HGX (or @andrey)
> "React thumbsup to the last message in #eng-general" → get message ts from `mcp__slack-intel__conversations_history`, ask approval, then `reactions_add`
