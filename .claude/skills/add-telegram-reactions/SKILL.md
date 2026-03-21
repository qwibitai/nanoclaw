# Add Telegram Reactions

Extends the Telegram channel with emoji reaction support, enabling agents to react to messages using the `react_to_message` MCP tool.

## Prerequisites
The `add-reactions` skill must be applied first — it adds the DB schema, IPC handler, and `react_to_message` MCP tool.

## What this skill adds
- `sendReaction()` method on the Telegram channel class
- `reactToLatestMessage()` convenience method
- Incoming `message_reaction` event handler (stores reactions in DB)

## Usage
Once applied, agents can use the `react_to_message` tool:
```
react_to_message({ emoji: "👍" })                    // react to latest message
react_to_message({ emoji: "🔥", message_id: "123" }) // react to specific message
react_to_message({ emoji: "" })                       // remove reaction
```

## Notes
- Telegram Bot API 7.0+ required for sendReaction
- Bots can set one reaction per message
- Empty emoji string removes the reaction
- Incoming reactions require `allowed_updates` to include `message_reaction`
