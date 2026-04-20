---
name: slack-intel
description: Slack channel messages, channel list, thread replies, user directory, and message search — read freely. Post messages or react only with user approval. Tools: mcp__slack-intel__list_channels, get_channel_history, get_thread_replies, list_users, get_user_info, search_messages.
---

# Slack Intel

Read-side access to Alma Labs' Slack workspace for context, search, and people lookup.

## Read freely (no approval needed)

| Action | Tool |
|---|---|
| List channels | `mcp__slack-intel__list_channels` |
| Channel history | `mcp__slack-intel__get_channel_history` with channelId |
| Thread replies | `mcp__slack-intel__get_thread_replies` with channelId + threadTs |
| Find a person | `mcp__slack-intel__list_users` or `get_user_info` |
| Search messages | `mcp__slack-intel__search_messages` with query |

## Write actions (load /almanda-ops, ask approval first)

Posting to Slack goes through the Slack channel integration (outbound), not this MCP.
Use `mcp__nanoclaw__send_message` with a `target_group_jid` to post to a registered Slack group.
Always ask approval before posting to any channel other than the current conversation.

## People lookup pattern

When someone asks "how do I reach [name]?" or "who works on [area]?":
1. `mcp__slack-intel__list_users` — search by display name or real name
2. Return: display name, real name, title, timezone
3. Do NOT share user IDs or tokens in responses

## Examples

> "What was discussed in #eng-general this week?" → `get_channel_history` for #eng-general, filter by date
> "Find any Slack messages about the auth bug" → `search_messages` query="auth bug"
> "Who is the head of design at Alma?" → `list_users` + filter by title
> "Show me the thread where we decided on the DB schema" → `search_messages` + `get_thread_replies`
