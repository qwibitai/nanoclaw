---
name: discord-threads
description: Create and manage Discord threads in the current channel. Use when you need to organize discussions into threads, create focused conversation spaces, or manage existing threads.
---

# Discord Thread Management

Create and manage threads in Discord channels using MCP tools.

## Available Tools

### `discord_create_thread`

Create a new thread in the current Discord channel.

**Parameters:**
- `name` (required) — Thread title (max 100 characters)
- `auto_archive_minutes` (optional) — Auto-archive after inactivity: `60`, `1440` (1 day), `4320` (3 days), or `10080` (7 days). Default: `1440`
- `initial_message` (optional) — First message to post in the thread

**Returns:** `{ threadId, threadJid }` — the new thread's Discord ID and JID for messaging.

### `discord_manage_thread`

Manage an existing Discord thread.

**Parameters:**
- `thread_id` (required) — The Discord thread ID
- `action` (required) — One of: `archive`, `unarchive`, `lock`, `unlock`, `rename`
- `name` (optional) — New name when action is `rename`

**Returns:** `{ success, message }`

## Usage Notes

- These tools only work in Discord channels (chatJid starts with `dc:`)
- The bot needs `MANAGE_THREADS` and `CREATE_PUBLIC_THREADS` permissions in the server
- After creating a thread, messages sent to the thread are automatically routed there
- When someone messages in a thread, the agent receives and replies in the same thread
