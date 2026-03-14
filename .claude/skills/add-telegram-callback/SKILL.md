---
name: add-telegram-callback
description: Add inline keyboard (callback query) support to the Telegram channel. After applying, agents can send messages with clickable buttons, and button presses are routed to the agent as structured JSON events.
---

# Add Telegram Callback Query Support

This skill adds inline keyboard button support to the Telegram channel. After applying, you can send messages with `reply_markup` inline keyboards, and when users press buttons, the event is routed to the agent as a structured JSON message — not a raw string — making it easy to parse without regex.

## Prerequisites

This skill requires the Telegram channel to already be installed. Run `/add-telegram` first if you haven't already.

## Phase 1: Check Prerequisites

```bash
test -f src/channels/telegram.ts && echo "OK" || echo "MISSING — run /add-telegram first"
```

If missing, stop and tell the user to run `/add-telegram` first.

## Phase 2: Apply Code Changes

Open `src/channels/telegram.ts` and find this block near the end of the `connect()` method, just before `this.bot.catch`:

```typescript
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
```

Insert the following callback query handler **between** those two blocks:

```typescript
    // Handle inline keyboard button clicks
    this.bot.on('callback_query:data', async (ctx) => {
      // Immediately acknowledge to dismiss the loading indicator
      await ctx.answerCallbackQuery();

      const chatJid = `tg:${ctx.chat?.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const senderName =
        ctx.from?.first_name ??
        ctx.from?.username ??
        ctx.from?.id.toString() ??
        'Unknown';

      // Deliver as structured JSON so agents can parse without regex
      const payload = {
        _type: 'callback_query',
        data: ctx.callbackQuery.data,
        message_id: ctx.callbackQuery.message?.message_id,
        query_id: ctx.callbackQuery.id,
        from_name: senderName,
      };

      this.opts.onMessage(chatJid, {
        id: ctx.callbackQuery.id,
        chat_jid: chatJid,
        sender: ctx.from?.id.toString() ?? 'unknown',
        sender_name: senderName,
        content: JSON.stringify(payload),
        timestamp: new Date().toISOString(),
        is_from_me: false,
      });

      logger.info(
        { chatJid, data: ctx.callbackQuery.data, sender: senderName },
        'Telegram callback query stored',
      );
    });

```

## Phase 3: Build and Validate

```bash
npm run build
```

The build must be clean with no TypeScript errors.

```bash
npx vitest run src/channels/telegram.test.ts 2>/dev/null || echo "No test file found, skipping"
```

## Phase 4: Restart and Test

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

Tell the user:

> Callback query support is now active. Send a test message with an inline keyboard:
>
> ```bash
> curl -s "https://api.telegram.org/bot<TOKEN>/sendMessage" \
>   -H "Content-Type: application/json" \
>   -d '{
>     "chat_id": "<CHAT_ID>",
>     "text": "Test inline keyboard",
>     "reply_markup": {
>       "inline_keyboard": [[
>         {"text": "✅ Yes", "callback_data": "answer_yes"},
>         {"text": "❌ No",  "callback_data": "answer_no"}
>       ]]
>     }
>   }'
> ```
>
> When you tap a button, the agent will receive:
> ```json
> {"_type":"callback_query","data":"answer_yes","message_id":123,"query_id":"...","from_name":"Alice"}
> ```

## How Agents Use This

When a user taps a button, the agent receives a message whose `content` is a JSON string:

```json
{
  "_type": "callback_query",
  "data": "answer_yes",
  "message_id": 123,
  "query_id": "287714725902572059",
  "from_name": "Alice"
}
```

Agents should parse this with `JSON.parse()` and check `_type === "callback_query"` before handling.

**`message_id`** is the ID of the original message that contained the buttons. Agents can use this to edit that message — for example, to mark the selected button — via `editMessageReplyMarkup` through the Telegram Bot API or a host IPC call.

### Example: Confirmation flow

Agent sends:
```
Should I add this paper to your reading list?
[✅ Add it]  [⏭ Skip]
```

User taps "Add it" → Agent receives:
```json
{"_type":"callback_query","data":"add_to_list","message_id":250,"query_id":"...","from_name":"Alice"}
```

Agent can then:
1. Act on `data` ("add_to_list")
2. Edit the original message (using `message_id`) to show which option was selected

### Example: Agent-side parsing

```typescript
const event = JSON.parse(msg.content);
if (event._type === 'callback_query') {
  handleButtonPress(event.data, event.message_id);
}
```

## Removal

Delete the `callback_query:data` handler block added in Phase 2, then rebuild:

```bash
npm run build
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```
