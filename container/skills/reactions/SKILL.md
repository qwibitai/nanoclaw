---
name: reactions
description: React to WhatsApp messages with emoji. Use when the user asks you to react, when acknowledging a message with a reaction makes sense, or when you want to express a quick response without sending a full message.
---

# Reactions

React to messages with emoji using the `mcp__nanoclaw__react_to_message` tool.

## When to use

- User explicitly asks you to react ("react with a thumbs up", "heart that message")
- Quick acknowledgment is more appropriate than a full text reply
- Expressing agreement, approval, or emotion about a specific message

## How to use

### React to the latest message

```
mcp__nanoclaw__react_to_message(emoji: "👍")
```

Omitting `message_id` reacts to the most recent message in the chat.

### React to a specific message

```
mcp__nanoclaw__react_to_message(emoji: "❤️", message_id: "3EB0F4C9E7...")
```

Pass a `message_id` to react to a specific message. **Always query the database first to get the correct ID** — never omit `message_id` when the user refers to someone else's message, or you will react to the wrong message (your own trigger message is the most recent one).

#### Find recent messages in the chat

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT id, sender_name, substr(content, 1, 80), timestamp
  FROM messages
  WHERE chat_jid = '<chat_jid>'
  ORDER BY timestamp DESC
  LIMIT 5;
"
```

#### Find the last message from a specific person

When asked to react to someone else's message (e.g. "Harry's last message"), filter by `sender_name`:

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT id, sender_name, substr(content, 1, 80), timestamp
  FROM messages
  WHERE chat_jid = '<chat_jid>'
    AND sender_name LIKE '%Harry%'
    AND is_from_me = 0
  ORDER BY timestamp DESC
  LIMIT 1;
"
```

Then pass the returned `id` as `message_id`. Never skip this lookup step.

### Remove a reaction

Send an empty string to remove your reaction:

```
mcp__nanoclaw__react_to_message(emoji: "")
```

## Common emoji

| Emoji | When to use              |
| ----- | ------------------------ |
| 👍    | Acknowledgment, approval |
| ❤️    | Appreciation, love       |
| 😂    | Something funny          |
| 🔥    | Impressive, exciting     |
| 🎉    | Celebration, congrats    |
| 🙏    | Thanks, prayer           |
| ✅    | Task done, confirmed     |
| ❓    | Needs clarification      |
